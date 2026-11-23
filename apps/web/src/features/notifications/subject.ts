import { requestKey } from "@everyfield/contracts/common";
import { feedSubject } from "@everyfield/contracts/notifications";
import type { RequestActor } from "@everyfield/domain/access";
import { z } from "zod";
import type { Reply } from "./model.ts";
import type { Mount } from "./server.ts";

export type Marked = { markedIds: string[] };

export const subjectReadRequest = z.strictObject({ requestKey, subject: feedSubject });

export async function markSubject(
	m: Pick<Mount, "db" | "producer">,
	actor: RequestActor,
	request: z.output<typeof subjectReadRequest>,
): Promise<Reply<Marked>> {
	const page = await m.producer.readFeedPage(m.db, actor, {});
	if (page.status !== "ok") return page;
	const { kind, id } = request.subject;
	const noticeIds = page.value.feed.items
		.filter((i) => i.subject?.kind === kind && i.subject.id === id)
		.map((i) => i.id);
	if (!noticeIds.length) return { status: "ok", value: { markedIds: [] } };
	return m.producer.markSelectedRead(m.db, actor, {
		requestKey: request.requestKey,
		expectedRevision: page.value.revision,
		input: { noticeIds },
	});
}
