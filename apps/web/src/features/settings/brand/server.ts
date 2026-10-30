import "server-only";
import { brandError, type BrandKit, type BrandReply } from "@everyfield/contracts/branding";
import { eq } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { brandReader, brandWriter } from "@everyfield/domain/branding";
import { randomUUID } from "node:crypto";
import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { BrandView } from "../port";

// The brand kit mount (WP-104/ui): the one door from the brand server actions to the brand domain. The actor comes
// from the request's getViewer; the domain checks the live Owner or Admin seat inside the statement that reads or
// writes (C13), so a Member's call returns access_denied and no kit data.

type Db = NonNullable<ReturnType<typeof requestDatabase>>;
type Actor = NonNullable<Awaited<ReturnType<typeof getViewer>>>["authority"];

const unavailable = (): BrandReply<never> => ({
	status: "refused",
	error: brandError.parse({ code: "unavailable", details: {}, correlationId: randomUUID(), retry: "never" }),
});

/** Runs one brand call. A thrown error is logged and reads as unavailable; the screen then offers Load latest. */
async function run<T>(outcome: string, call: (db: Db, actor: NonNullable<Actor>) => Promise<BrandReply<T>>) {
	const viewer = await getViewer();
	const db = requestDatabase();
	if (!db || viewer?.status !== "active" || !viewer.authority) return unavailable();
	try {
		return await call(db, viewer.authority);
	} catch (error) {
		console.error(JSON.stringify({ component: "brand", outcome, error: String(error) }));
		return unavailable();
	}
}

/**
 * The saved kit and the church name, started together: two statements after the session, however many fields the kit
 * has. The name is returned only when the kit read passed its live check.
 */
export function readBrand(): Promise<BrandReply<BrandView>> {
	return run("read_failed", async (db, actor) => {
		const context = actor.actor.context;
		const plantId = context.kind === "seat" && context.owner.kind === "plant" ? context.owner.id : null;
		const [reply, named] = await Promise.all([
			brandReader.get(db, actor, {}),
			plantId
				? db.select({ name: t.plant.name }).from(t.plant).where(eq(t.plant.id, plantId)).limit(1)
				: Promise.resolve([]),
		]);
		if (reply.status === "refused") return reply;
		const churchName = named[0]?.name;
		return churchName ? { status: "ok", value: { kit: reply.value, churchName } } : unavailable();
	});
}

export function saveBrandKit(raw: unknown): Promise<BrandReply<BrandKit>> {
	return run("save_failed", (db, actor) => brandWriter.saveSettings(db, actor, raw));
}

export function resetBrandKit(raw: unknown): Promise<BrandReply<BrandKit>> {
	return run("reset_failed", (db, actor) => brandWriter.reset(db, actor, raw));
}
