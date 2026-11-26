import "server-only";
import { instant, revision as revisionId } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/onboarding";
import { catalogVersion, templateKey } from "@everyfield/contracts/tasks";
import { and, eq, isNull, sql, type SQL } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { z } from "zod";
import { liveAccess, liveRead } from "../access/session.ts";
import { CATALOG } from "../tasks/index.ts";
import {
	actor,
	begin,
	deny,
	event,
	finish,
	OnboardingReadContext,
	parse,
	readReply,
	reply,
	revision,
	type Context,
	type Tx,
	type WriteContext,
} from "./core.ts";

const STARTER = "discernment-and-preparation";
export const starter =
	CATALOG.checklists.find((k) => k.key === STARTER) ?? fail(`The tasks catalog has no ${STARTER} checklist`);
function fail(message: string): never {
	throw Error(message);
}
const storedSteps = z.array(z.strictObject({ key: templateKey, catalog_version: catalogVersion, done_at: instant }));
export const doneSteps = (raw: unknown) => new Map(storedSteps.parse(raw).map((s) => [s.key, new Date(s.done_at)]));
type Discovery = Pick<typeof t.discovery.$inferSelect, "id" | "steps" | "steps_revision">;

function view(d: Discovery) {
	const done = doneSteps(d.steps);
	return c.discoverySteps.parse({
		discoveryId: d.id,
		revision: d.steps_revision,
		catalogVersion: CATALOG.version,
		steps: starter.items.map((i) => ({
			key: i.key,
			title: i.title,
			description: i.description,
			doneAt: done.get(i.key)?.toISOString() ?? null,
		})),
	});
}
async function openDiscovery(tx: Tx, accountId: string, live: SQL | undefined, lock: boolean) {
	const query = tx
		.select({ id: t.discovery.id, steps: t.discovery.steps, steps_revision: t.discovery.steps_revision })
		.from(t.discovery)
		.where(
			and(
				eq(t.discovery.account_id, accountId),
				isNull(t.discovery.converted_at),
				sql`NOT EXISTS(SELECT FROM seat s WHERE s.account_id=${accountId}::uuid AND s.ended_at IS NULL)`,
				live,
			),
		);
	const [d] = await (lock ? query.for("update") : query);
	return d ?? deny("unavailable");
}

export const discoveryStepOperations = {
	async getDiscoverySteps(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			parse(c.getDiscoveryStepsRequest, raw);
			if (ctx.selected.kind !== "account") deny("unavailable");
			const a = await actor(tx, ctx);
			const live = ctx instanceof OnboardingReadContext ? liveRead(liveAccess(ctx.authority)) : undefined;
			return view(await openDiscovery(tx, a.account.id, live, false));
		});
	},
	async setDiscoveryStep(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const q = parse(c.setDiscoveryStepRequest, raw);
			if (ctx.selected.kind !== "account") deny("unavailable");
			const a = await actor(tx, ctx, false, true);
			const d = await openDiscovery(tx, a.account.id, undefined, true);
			if (d.id !== q.input.discoveryId) deny("unavailable");
			const step = starter.items.find((i) => i.key === q.input.stepKey) ?? deny("invalid_input");
			const cx = await begin(tx, ctx, a.account.id, "discovery.setStep", q);
			if (cx.kind === "replay") return c.discoverySteps.parse(cx.value);
			revision(q.expectedRevision, d.steps_revision);
			const stored = storedSteps.parse(d.steps);
			if (stored.some((s) => s.key === step.key) === q.input.done)
				return finish(tx, cx, c.discoverySteps, () => view(d));
			const next: Discovery = {
				id: d.id,
				steps: q.input.done
					? [...stored, { key: step.key, catalog_version: CATALOG.version, done_at: new Date().toISOString() }]
					: stored.filter((s) => s.key !== step.key),
				steps_revision: revisionId.parse(String(BigInt(d.steps_revision) + 1n)),
			};
			cx.writes.push(
				tx
					.update(t.discovery)
					.set({ steps: next.steps, steps_revision: sql`${t.discovery.steps_revision}+1` })
					.where(and(eq(t.discovery.id, d.id), eq(t.discovery.steps_revision, d.steps_revision))),
			);
			await event(tx, cx, d.id, "tasks.changed", q.input.done ? "tick" : "untick");
			return finish(tx, cx, c.discoverySteps, () => view(next));
		});
	},
};
