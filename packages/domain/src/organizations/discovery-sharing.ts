import { revision, type Owner, type sessionId } from "@everyfield/contracts/common";
import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import * as Q from "@everyfield/contracts/organizations";
import { eq, sql, type SQLWrapper } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { z } from "zod";
import { liveAccess, liveRead, type RequestActor, type WriteTx } from "../access/session.ts";
import { foundationArticles } from "../onboarding/reading.ts";
import { auditSavepoint } from "../operations/writes.ts";
import {
	active,
	appendEvent,
	beginCommand,
	checkRevision,
	discoveryOpen,
	finishCommand,
	invalidate,
	linkActive,
	loadAffiliations,
	pairOf,
	refuse,
	seatless,
	writeActor,
	type OrganizationEffects,
	type Reader,
} from "./core.ts";

const ordinaryLink = (id: SQLWrapper) =>
	sql<boolean>`NOT EXISTS(SELECT FROM residency_link r WHERE r.affiliation_id=${id})`;

export function discoverySharingOperations(
	effects: OrganizationEffects,
): Pick<OrganizationAdapter<WriteTx>, "discovery.setSharing"> {
	return {
		async "discovery.setSharing"(tx, session: z.infer<typeof sessionId>, selected: Owner, raw) {
			return auditSavepoint(tx, async () => {
				const q = Q.setDiscoverySharingRequest.parse(raw),
					actor = await writeActor(tx, session, selected);
				if (actor.status !== "active" || actor.context.kind !== "account" || selected.kind !== "account") refuse();
				const own = sql`${actor.accountId}::uuid`;
				const [a] = await loadAffiliations(
					tx,
					sql`${eq(tables.affiliation.id, q.input.relationshipId)} AND ${eq(tables.affiliation.account_id, actor.accountId)}
						AND ${ordinaryLink(tables.affiliation.id)} AND ${discoveryOpen(own)} AND ${seatless(own)}`,
					true,
				);
				if (!a || !active(a)) refuse();
				const pair = pairOf(a);
				const c = await beginCommand(tx, actor, selected, "discovery.setSharing", q);
				if (c.kind === "replay") return Q.mutationResult.parse(c.result);
				checkRevision(q.expectedRevision, a.revision);
				checkRevision(q.input.expectedConsentRevision, a.consent_revision);
				if (a.share_foundations !== q.input.shareFoundations) {
					c.writes.push(
						tx
							.update(tables.affiliation)
							.set({
								share_foundations: q.input.shareFoundations,
								consent_revision: sql`${tables.affiliation.consent_revision}+1`,
								revision: sql`${tables.affiliation.revision}+1`,
							})
							.where(eq(tables.affiliation.id, a.id)),
					);
					const next = String(BigInt(a.revision) + 1n);
					await appendEvent(tx, c, a.id, "preference", "sharing.changed", a.revision, next);
					invalidate(tx, effects, c, pair, a.id, next);
				}
				return finishCommand(tx, c, () => ({ status: "committed" }) satisfies z.output<typeof Q.mutationResult>);
			});
		},
	};
}

const ownRow = z.object({
	id: z.uuid(),
	revision,
	consent_revision: revision,
	share_foundations: z.boolean(),
});

export async function readDiscoverySharing(db: Reader, authority: RequestActor) {
	const context = authority.actor.context;
	if (context.kind !== "account") return {};
	const account = authority.actor.accountId;
	const found = await db.execute(
		sql`SELECT a.id, a.revision::text AS revision, a.consent_revision::text AS consent_revision, a.share_foundations
		FROM affiliation a WHERE a.account_id=${account}::uuid AND ${linkActive("a")} AND ${ordinaryLink(sql`a.id`)}
			AND ${seatless(sql`a.account_id`)} AND ${liveRead(liveAccess(authority))}`,
	);
	return Object.fromEntries(
		found.rows.map((raw) => {
			const r = ownRow.parse(raw);
			return [
				r.id,
				Q.discoverySharing.parse({
					relationshipId: r.id,
					revision: r.revision,
					consentRevision: r.consent_revision,
					shareFoundations: r.share_foundations,
				}),
			];
		}),
	);
}

export async function readSharedFoundations(db: Reader, authority: RequestActor) {
	const owner = authority.actor.context.owner;
	if (owner.kind !== "organization") return {};
	const found = await db.execute(
		sql`SELECT a.id, coalesce((SELECT jsonb_agg(DISTINCT r.article_id) FROM reading r
				JOIN article_revision v ON v.id=r.completed_revision_id AND v.article_id=r.article_id
				WHERE r.account_id=a.account_id AND r.article_id=ANY(${sql.param(foundationArticles)}::uuid[])
					AND r.completed_at IS NOT NULL AND v.published_at IS NOT NULL),'[]'::jsonb) AS completed
		FROM affiliation a WHERE a.organization_id=${owner.id}::uuid AND a.account_id IS NOT NULL AND a.share_foundations
			AND ${linkActive("a")} AND ${ordinaryLink(sql`a.id`)} AND ${seatless(sql`a.account_id`)}
			AND ${liveRead(liveAccess(authority))}`,
	);
	return Object.fromEntries(
		found.rows.map((raw) => {
			const r = z.object({ id: z.uuid(), completed: z.array(z.uuid()) }).parse(raw);
			return [r.id, Q.sharedFoundations.parse({ completed: r.completed, total: foundationArticles.length })];
		}),
	);
}
