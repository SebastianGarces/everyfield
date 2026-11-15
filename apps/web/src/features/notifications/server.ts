import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createNotificationProducer, parseKeyRing } from "@everyfield/domain/notifications";
import { randomBytes } from "node:crypto";
import "server-only";
import type { FeedPage, FeedQuery, Outcome, Reply } from "./model.ts";

type Producer = ReturnType<typeof createNotificationProducer>;
export type Mount = { db: Database; producer: Producer; optOut: boolean };

let slot: { url: string; mount: Mount } | undefined;

export function notificationsMount(): Mount | null {
	const db = requestDatabase();
	const url = process.env.IDENTITY_DATABASE_URL;
	if (!db || !url) return null;
	if (slot?.url !== url) {
		const ring = parseKeyRing(process.env.NOTIFICATION_OPT_OUT_KEYS);
		const producer = createNotificationProducer({ optOutKeys: ring ?? { current: randomBytes(32) } });
		slot = { url, mount: { db, producer, optOut: ring !== null } };
	}
	return slot.mount;
}

export async function notificationActor(): Promise<RequestActor | null> {
	return (await getViewer())?.authority ?? null;
}

const outcome = <T>(reply: Reply<T>): Outcome<T> =>
	reply.status === "ok" ? reply : { status: "refused", code: reply.error.code };

export async function call<T>(run: (m: Mount) => Promise<Reply<T>>): Promise<Outcome<T>> {
	const mount = notificationsMount();
	if (!mount) return { status: "lost" };
	try {
		return outcome(await run(mount));
	} catch (error) {
		console.error(JSON.stringify({ component: "notifications", outcome: "failed", error: String(error) }));
		return { status: "lost" };
	}
}

export function loadFeedPage(actor: RequestActor, query: FeedQuery): Promise<Outcome<FeedPage>> {
	return call(({ db, producer }) =>
		producer.readFeedPage(db, actor, {
			...(query.category ? { category: query.category } : {}),
			...(query.unread ? { unread: true } : {}),
		}),
	);
}
