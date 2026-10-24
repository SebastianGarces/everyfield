"use server";

import { requestDatabase } from "@/server/database";
import type { DocumentsError } from "@everyfield/contracts/documents";
import { documentsReader } from "@everyfield/domain/documents";
import type { Format, Resolved } from "./model.ts";
import { documentActor } from "./server.ts";

// Field fill for the open template. The actor is read again here. The browser cannot name a person, meeting, or
// team. Preview bytes use their own route.

export type DocumentOutcome<T> =
	| { status: "ok"; value: T }
	| { status: "refused"; code: DocumentsError["code"]; problem?: string }
	| { status: "lost" };

function refused(error: DocumentsError): DocumentOutcome<never> {
	const problem = error.code === "invalid_input" ? error.details.issues[0]?.problem : undefined;
	return problem ? { status: "refused", code: error.code, problem } : { status: "refused", code: error.code };
}

async function run<T>(
	read: (
		db: NonNullable<ReturnType<typeof requestDatabase>>,
		actor: NonNullable<Awaited<ReturnType<typeof documentActor>>>,
	) => Promise<DocumentOutcome<T>>,
) {
	const actor = await documentActor();
	const db = requestDatabase();
	if (!actor || !db) return { status: "lost" } as const;
	try {
		return await read(db, actor);
	} catch (error) {
		console.error(JSON.stringify({ component: "documents", outcome: "action_failed", error: String(error) }));
		return { status: "lost" } as const;
	}
}

/** Filled fields for one template. Format does not change the fields. */
export async function resolveDocument(templateId: string, format: Format): Promise<DocumentOutcome<Resolved>> {
	return run(async (db, actor) => {
		const reply = await documentsReader.resolveContext(db, actor, { templateId, format });
		if (reply.status === "refused") return refused(reply.error);
		const value = reply.value;
		return {
			status: "ok",
			value: {
				templateId: value.templateId,
				format: value.format,
				fields: value.fields,
				missing: value.missing,
				complete: value.complete,
			},
		};
	});
}
