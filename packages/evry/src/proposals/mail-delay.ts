import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { mailDelay, readSwitches, type MailDelay, type Switches } from "@everyfield/domain/flags";
import { logFailure } from "@everyfield/domain/log";
import { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import { readable, type Operation, type Proposal } from "./review.ts";

export type ShownProposal = Proposal & MailDelay;

const INVITES: ReadonlySet<Operation> = new Set([
	"seats.invite",
	"seats.resendInvitation",
	"associations.invite",
	"associations.resendInvitation",
]);

async function unsentInvitations(db: Database, actor: EvryActor, ids: readonly string[]): Promise<ReadonlySet<string>> {
	try {
		const { rows } = await db.execute(sql`
			SELECT p.id FROM proposal p
			JOIN audit_event a ON a.tenant_id=p.tenant_id AND a.request_key='evry:'||p.id||':'||p.revision
			JOIN mail m ON m.operation_id=a.id AND m.tenant_id=a.tenant_id
			JOIN job j ON j.id=m.job_id AND j.tenant_id=m.tenant_id
			JOIN invitation i ON i.id=(p.receipt->>'receiptId')::uuid AND i.tenant_id=p.tenant_id
			WHERE p.id=ANY(${sql.param(ids)}::uuid[]) AND ${readable(actor)} AND p.outcome='completed'
				AND m.state IN ('pending','refused') AND j.state IN ('ready','retry_wait','claimed')
				AND i.state='pending' AND i.revision::text=p.receipt->>'revision'
				AND CASE WHEN i.purpose='seat' THEN i.created_at ELSE coalesce(i.resent_at,i.created_at) END>clock_timestamp()-interval '720 hours'`);
		return new Set(
			z
				.array(z.strictObject({ id: z.uuid() }))
				.parse(rows)
				.map((r) => r.id),
		);
	} catch (error) {
		logFailure({ component: "mail-delay", outcome: "read_failed" }, error);
		return new Set();
	}
}

export async function withMailDelays<K extends string>(
	db: Database,
	actor: EvryActor,
	reviews: Record<K, Proposal | null>,
	switches = () => readSwitches(db),
): Promise<Record<K, ShownProposal | null>> {
	const invites = Object.values<Proposal | null>(reviews).flatMap((p) =>
		p && p.outcome === "completed" && INVITES.has(p.operation) ? [p.id] : [],
	);
	if (!invites.length || !(await mailDelay(switches)).mailDelayed) return reviews;
	const unsent = await unsentInvitations(db, actor, invites);
	const shown: Record<K, ShownProposal | null> = { ...reviews };
	for (const key of Object.keys(reviews) as K[]) {
		const p = reviews[key];
		if (p && unsent.has(p.id)) shown[key] = { ...p, mailDelayed: true };
	}
	return shown;
}

export async function shownReview(
	db: Database,
	actor: EvryActor,
	review: Proposal,
	switches?: () => Promise<Switches>,
): Promise<ShownProposal> {
	return (await withMailDelays(db, actor, { review }, switches)).review ?? review;
}
