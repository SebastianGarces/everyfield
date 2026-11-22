import { outcomeOf } from "@everyfield/contracts/common";
import { requestDatabase } from "@/server/database";
import { serverEnv } from "@/server/config";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createNotificationProducer, parseKeyRing } from "@everyfield/domain/notifications";
import { randomBytes } from "node:crypto";
import "server-only";
import { stamped, type FeedPage, type FeedQuery, type Outcome, type Reply } from "./model.ts";
import { LOST, transient } from "../../server/platform/transient.ts";

type Producer = ReturnType<typeof createNotificationProducer>;
export type Mount = { db: Database; producer: Producer; optOut: boolean };

let mount: Mount | undefined;

export const optOutReady = (): boolean => parseKeyRing(serverEnv().NOTIFICATION_OPT_OUT_KEYS) !== null;

export function notificationsMount(): Mount {
	if (!mount) {
		const ring = parseKeyRing(serverEnv().NOTIFICATION_OPT_OUT_KEYS);
		const producer = createNotificationProducer({ optOutKeys: ring ?? { current: randomBytes(32) } });
		mount = { db: requestDatabase(), producer, optOut: ring !== null };
	}
	return mount;
}

export async function call<T>(run: (m: Mount) => Promise<Reply<T>>): Promise<Outcome<T>> {
	const mount = notificationsMount();
	return transient({ component: "notifications", outcome: "failed" }, async () => outcomeOf(await run(mount)), LOST);
}

export async function loadFeedPage(actor: RequestActor, query: FeedQuery): Promise<Outcome<FeedPage>> {
	const page = await call(({ db, producer }) =>
		producer.readFeedPage(db, actor, {
			...(query.category ? { category: query.category } : {}),
			...(query.unread ? { unread: true } : {}),
		}),
	);
	return stamped(page, Date.now());
}
