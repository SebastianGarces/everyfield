import { requestDatabase } from "@/server/database";
import { recordId } from "@everyfield/contracts/common";
import type { RequestActor } from "@everyfield/domain/access";
import { documentsWriter } from "@everyfield/domain/documents";
import "server-only";
import { writtenView, type WrittenView } from "../model.ts";
import { logFailure } from "@everyfield/domain/log";

export type WrittenLoad = { status: "ok"; value: WrittenView } | { status: "missing" } | { status: "failed" };

export async function loadWritten(authority: RequestActor, raw: string): Promise<WrittenLoad> {
	const id = recordId.safeParse(raw);
	if (!id.success) return { status: "missing" };
	const db = requestDatabase();
	if (!db) return { status: "failed" };
	try {
		const reply = await documentsWriter.read(db, authority, { documentId: id.data });
		if (reply.status !== "ok") return { status: "missing" };
		if (reply.value.kind !== "native" && reply.value.kind !== "core_values") return { status: "missing" };
		return { status: "ok", value: writtenView(reply.value) };
	} catch (error) {
		logFailure({ component: "documents", outcome: "written_read_failed" }, error);
		return { status: "failed" };
	}
}
