import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { ChurchPage, DocumentsError } from "@everyfield/contracts/documents";
import type { RequestActor } from "@everyfield/domain/access";
import { privateStorage } from "@everyfield/db/schema";
import { documentsReader } from "@everyfield/domain/documents";
import "server-only";
import {
	choose,
	filterTemplates,
	offeredFormat,
	type DocumentsQuery,
	type Format,
	type Resolved,
	type Template,
} from "./model.ts";

// The documents screens' reads. The library is the full catalog (one account check). The selected template's church
// values are a second read, and only for a plant seat. Preview bytes are a separate request, not part of the page.

export type DocumentsLoad =
	| { status: "ok"; templates: Template[]; version: string; context: Resolved | null; canPreview: boolean }
	| { status: "refused" }
	| { status: "failed" };

/** The request's active actor, or null when there is no active account. */
export async function documentActor(): Promise<RequestActor | null> {
	return (await documentSession())?.actor ?? null;
}

/** The active actor and the signed-in account's own name, from one viewer read. */
export async function documentSession() {
	const viewer = await getViewer();
	if (!viewer || viewer.status !== "active" || !viewer.authority) return null;
	return {
		actor: viewer.authority,
		author: {
			id: "accountId" in viewer ? viewer.accountId : null,
			name: viewer.displayName?.trim() || null,
		},
	};
}

export type PreviewOutcome =
	| { status: "ok"; value: Resolved & { artifact: string | null } }
	| { status: "refused"; code: DocumentsError["code"]; problem?: string }
	| { status: "lost" };

/**
 * Exact preview bytes for one template. Nothing is stored. The browser cannot name a person, meeting, or team.
 * The actor is read again here.
 */
export async function readPreview(
	templateId: string,
	format: Format,
	overrides: Record<string, string>,
): Promise<PreviewOutcome> {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" };
	try {
		const reply = await documentsReader.preview(db, actor, { templateId, format, overrides });
		if (reply.status === "refused") {
			const problem = reply.error.code === "invalid_input" ? reply.error.details.issues[0]?.problem : undefined;
			return problem
				? { status: "refused", code: reply.error.code, problem }
				: { status: "refused", code: reply.error.code };
		}
		const value = reply.value;
		const artifact = "artifact" in value ? value.artifact : undefined;
		if (typeof artifact !== "string" && artifact !== null) return { status: "lost" };
		return {
			status: "ok",
			value: {
				templateId: value.templateId,
				format: value.format,
				fields: value.fields,
				missing: value.missing,
				complete: value.complete,
				artifact,
			},
		};
	} catch (error) {
		console.error(JSON.stringify({ component: "documents", outcome: "action_failed", error: String(error) }));
		return { status: "lost" };
	}
}

export function hasPlantSeat(authority: RequestActor) {
	const context = authority.actor.context;
	return context.kind === "seat" && context.owner.kind === "plant";
}

function present(value: {
	templateId: string;
	format: Resolved["format"];
	fields: Resolved["fields"];
	missing: string[];
	complete: boolean;
}): Resolved {
	return {
		templateId: value.templateId,
		format: value.format,
		fields: value.fields,
		missing: value.missing,
		complete: value.complete,
	};
}

/**
 * The library, then the selected template's filled fields. List and resolve stay in order: the selected id depends on
 * the catalog. A plant seat adds the resolve statement. An account with no church seat still receives the library.
 */
export async function loadDocuments(authority: RequestActor, query: DocumentsQuery): Promise<DocumentsLoad> {
	const db = requestDatabase();
	if (!db) return { status: "failed" };
	try {
		const list = await documentsReader["templates.list"](db, authority, {});
		if (list.status !== "ok") return { status: "refused" };
		const templates = list.value.templates;
		const chosen = choose(filterTemplates(templates, query), query.template);
		const canPreview = hasPlantSeat(authority);
		if (!chosen || !canPreview) {
			return { status: "ok", templates, version: list.value.version, context: null, canPreview };
		}
		const resolved = await documentsReader.resolveContext(db, authority, {
			templateId: chosen.id,
			format: offeredFormat(chosen, query.format),
		});
		if (resolved.status === "ok") {
			return { status: "ok", templates, version: list.value.version, context: present(resolved.value), canPreview };
		}
		if (resolved.error.code === "unavailable") {
			return { status: "ok", templates, version: list.value.version, context: null, canPreview: false };
		}
		console.error(JSON.stringify({ component: "documents", outcome: "resolve_refused", code: resolved.error.code }));
		return { status: "failed" };
	} catch (error) {
		console.error(JSON.stringify({ component: "documents", outcome: "read_failed", error: String(error) }));
		return { status: "failed" };
	}
}

/** Account context, or a plant seat. An organization seat has neither library of written documents. */
export function writtenScope(authority: RequestActor): "church" | "account" | null {
	const context = authority.actor.context;
	if (context.kind === "account") return "account";
	if (context.kind === "seat" && context.owner.kind === "plant") return "church";
	return null;
}

/** Members can read written documents. They cannot save, import, archive, or designate. */
export function canEditDocuments(authority: RequestActor) {
	const context = authority.actor.context;
	if (context.kind === "account") return true;
	return context.kind === "seat" && context.owner.kind === "plant" && context.role !== "member";
}

/** Private storage is configured for this process. Generation and import need it. Text save does not. */
export function canStoreDocuments() {
	return privateStorage() !== null;
}

/** An Owner or Admin of the church plant. A Member and an account with no church seat are not. */
export function canCreateChurchDocuments(authority: RequestActor) {
	const context = authority.actor.context;
	return context.kind === "seat" && context.owner.kind === "plant" && context.role !== "member";
}

/** The church plant's Church Documents for the list. Null when the read fails or the account has no church seat. */
export async function loadChurchList(authority: RequestActor) {
	const db = requestDatabase();
	if (!db || !hasPlantSeat(authority)) return null;
	try {
		const reply = await documentsReader.listChurch(db, authority, {});
		return reply.status === "ok" ? reply.value : null;
	} catch (error) {
		console.error(JSON.stringify({ component: "documents", outcome: "church_list_failed", error: String(error) }));
		return null;
	}
}

type ChurchLoad = { status: "ok"; page: ChurchPage } | { status: "not_found" } | { status: "failed" };

/** One Church Document's page. Another plant's document, an unknown id and a seatless account all read as not found. */
export async function loadChurchPage(authority: RequestActor, documentId: string): Promise<ChurchLoad> {
	const db = requestDatabase();
	if (!db) return { status: "failed" };
	try {
		const reply = await documentsReader.readChurch(db, authority, { documentId });
		if (reply.status === "ok") return { status: "ok", page: reply.value };
		return reply.error.code === "invalid_input" ||
			reply.error.code === "unavailable" ||
			reply.error.code === "access_denied"
			? { status: "not_found" }
			: { status: "failed" };
	} catch (error) {
		console.error(JSON.stringify({ component: "documents", outcome: "church_page_failed", error: String(error) }));
		return { status: "failed" };
	}
}
