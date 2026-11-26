import { requestDatabase } from "@/server/database";
import { viewerActor } from "@/server/request-context";
import type { Database } from "@everyfield/db/client";
import type { Lost, Outcome } from "@everyfield/contracts/common";
import type { DocumentsError } from "@everyfield/contracts/documents";
import type { RequestActor } from "@everyfield/domain/access";
import { privateStorage } from "@everyfield/db/schema";
import { documentsReader, documentsWriter } from "@everyfield/domain/documents";
import "server-only";
import {
	choose,
	filterTemplates,
	offeredFormat,
	type DocumentsQuery,
	type Format,
	type Resolved,
	type OwnedView,
	type Template,
} from "./model.ts";
import { presentOwned, refused, type DocumentOutcome } from "./outcome.ts";
import { logLine } from "@everyfield/domain/log";
import { LOST, transient } from "../../server/platform/transient.ts";
import { readDb } from "../../server/platform/tx.ts";

export type DocumentsLoad =
	| {
			status: "ok";
			templates: Template[];
			version: string;
			context: Resolved | null;
			canPreview: boolean;
			mine: DocumentOutcome<OwnedView[]> | null;
	  }
	| { status: "refused" }
	| Lost;

export type PreviewOutcome = Outcome<
	Resolved & { artifact: string | null; brandKit: boolean },
	DocumentsError["code"],
	{ path?: string }
>;

export async function readPreview(
	templateId: string,
	format: Format,
	overrides: Record<string, string>,
	meetingId?: unknown,
): Promise<PreviewOutcome> {
	const actor = await viewerActor();
	if (!actor) return { status: "refused", code: "access_denied" };
	const reply = await transient(
		{ component: "documents", outcome: "action_failed" },
		() =>
			documentsReader.preview(requestDatabase(), actor, { templateId, format, overrides, meetingId }, privateStorage()),
		LOST,
	);
	if (reply.status === "lost") return reply;
	if (reply.status === "refused") {
		const path = reply.error.code === "invalid_input" ? reply.error.details.issues[0]?.path : undefined;
		return path ? { status: "refused", code: reply.error.code, path } : { status: "refused", code: reply.error.code };
	}
	const value = reply.value;
	return {
		status: "ok",
		value: {
			templateId: value.templateId,
			format: value.format,
			fields: value.fields,
			missing: value.missing,
			complete: value.complete,
			artifact: value.artifact,
			brandKit: value.brandKit,
		},
	};
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

export async function loadDocuments(authority: RequestActor, query: DocumentsQuery): Promise<DocumentsLoad> {
	return readDb("documents", async (db): Promise<DocumentsLoad> => {
		const list = await documentsReader["templates.list"](db, authority, {});
		if (list.status !== "ok") return { status: "refused" };
		const templates = list.value.templates;
		const chosen = choose(filterTemplates(templates, query), query.template);
		const canPreview = hasPlantSeat(authority);
		const mine = canPreview ? await mineOf(db, authority) : null;
		const loaded = { status: "ok", templates, version: list.value.version, mine } as const;
		if (!chosen || !canPreview) return { ...loaded, context: null, canPreview };
		const resolved = await documentsReader.resolveContext(db, authority, {
			templateId: chosen.id,
			format: offeredFormat(chosen, query.format),
		});
		if (resolved.status === "ok") return { ...loaded, context: present(resolved.value), canPreview };
		if (resolved.error.code === "unavailable") return { ...loaded, context: null, canPreview: false };
		logLine({ component: "documents", outcome: "resolve_refused", code: resolved.error.code });
		return LOST;
	});
}

export async function mineOf(db: Database, authority: RequestActor): Promise<DocumentOutcome<OwnedView[]>> {
	const listed = await documentsWriter.listMine(db, authority, {});
	if (listed.status === "refused") return refused(listed.error);
	return { status: "ok", value: listed.value.documents.map(presentOwned) };
}

export function writtenScope(authority: RequestActor): "church" | "account" | null {
	const context = authority.actor.context;
	if (context.kind === "account") return "account";
	if (context.kind === "seat" && context.owner.kind === "plant") return "church";
	return null;
}

export function canEditDocuments(authority: RequestActor) {
	const context = authority.actor.context;
	if (context.kind === "account") return true;
	return context.kind === "seat" && context.owner.kind === "plant" && context.role !== "member";
}

export function canStoreDocuments() {
	return privateStorage() !== null;
}
