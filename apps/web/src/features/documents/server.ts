import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { RequestActor } from "@everyfield/domain/access";
import { documentsReader } from "@everyfield/domain/documents";
import "server-only";
import { choose, filterTemplates, offeredFormat, type DocumentsQuery, type Resolved, type Template } from "./model.ts";

// The documents screens' reads. The library is the full catalog (one account check). The selected template's church
// values are a second read, and only for a plant seat. Preview bytes are not part of the page.

export type DocumentsLoad =
	| { status: "ok"; templates: Template[]; version: string; context: Resolved | null; canPreview: boolean }
	| { status: "refused" }
	| { status: "failed" };

/** The request's active actor, or null when there is no active account. */
export async function documentActor(): Promise<RequestActor | null> {
	const viewer = await getViewer();
	if (!viewer || viewer.status !== "active") return null;
	return viewer.authority;
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
