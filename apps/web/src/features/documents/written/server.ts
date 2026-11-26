import { requestDatabase } from "@/server/database";
import { recordId } from "@everyfield/contracts/common";
import type { RequestActor } from "@everyfield/domain/access";
import { documentsWriter } from "@everyfield/domain/documents";
import "server-only";
import { writtenView, type WrittenView } from "../model.ts";
import { transient } from "../../../server/platform/transient.ts";

export type WrittenLoad =
	{ status: "ok"; value: WrittenView; mine: boolean } | { status: "missing" } | { status: "failed" };

export async function loadWritten(authority: RequestActor, raw: string): Promise<WrittenLoad> {
	const id = recordId.safeParse(raw);
	if (!id.success) return { status: "missing" };
	const db = requestDatabase();
	return transient(
		{ component: "documents", outcome: "written_read_failed" },
		async () => {
			const church = authority.actor.context.kind === "seat";
			const shared = church ? await documentsWriter.read(db, authority, { documentId: id.data }) : null;
			const mine =
				shared?.status === "ok" ? null : await documentsWriter.readMine(db, authority, { documentId: id.data });
			const reply = shared?.status === "ok" ? shared : mine;
			if (reply?.status !== "ok") return { status: "missing" };
			if (reply.value.kind !== "native" && reply.value.kind !== "core_values") return { status: "missing" };
			return { status: "ok", value: writtenView(reply.value), mine: reply === mine };
		},
		{ status: "failed" },
	);
}
