import { requestDatabase } from "@/server/database";
import type { DocumentsError } from "@everyfield/contracts/documents";
import type { RequestActor } from "@everyfield/domain/access";
import "server-only";
import type { OwnedView, SavedFile } from "./model.ts";
import { logFailure } from "@everyfield/domain/log";

export type Read<T> = (
	db: NonNullable<ReturnType<typeof requestDatabase>>,
	actor: RequestActor,
) => Promise<DocumentOutcome<T>>;

export type DocumentOutcome<T> =
	| { status: "ok"; value: T }
	| { status: "refused"; code: DocumentsError["code"]; problem?: string; path?: string }
	| { status: "lost" };

export const storageMissing = {
	status: "refused" as const,
	code: "unavailable" as const,
	problem: "Saving is not available right now.",
};

export function refused(error: DocumentsError): DocumentOutcome<never> {
	const issue = error.code === "invalid_input" ? error.details.issues[0] : undefined;
	return issue
		? { status: "refused", code: error.code, problem: issue.problem, path: issue.path }
		: { status: "refused", code: error.code };
}

export async function runAs<T>(actor: RequestActor | null, read: Read<T>) {
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" } as const;
	try {
		return await read(db, actor);
	} catch (error) {
		logFailure({ component: "documents", outcome: "action_failed" }, error);
		return { status: "lost" } as const;
	}
}

export function presentSaved(value: SavedFile): SavedFile {
	return {
		id: value.id,
		savedTemplateName: value.savedTemplateName,
		format: value.format,
		generatedAt: value.generatedAt,
		downloadName: value.downloadName,
	};
}

export function presentOwned(value: OwnedView): OwnedView {
	return { id: value.id, kind: value.kind, title: value.title, archived: value.archived };
}
