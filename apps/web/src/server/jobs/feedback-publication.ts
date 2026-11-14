import type { Database, Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { issueHash, publicIssue, type PublicIssue } from "@everyfield/domain/feedback/public";
import "server-only";
import { z } from "zod";
import { transaction } from "../platform/database.ts";
import type { HeldReason } from "@everyfield/contracts/feedback";
import type { IssueClient, IssueLink } from "./github.ts";
import { claimDue, finishClaim, lockClaim, recoverLease, type Claim } from "./queue.ts";

// The feedback publication worker (REQ-ADM-003). feedback.submit queues one feedback_publication job with the feedback;
// the scheduled runner claims it here. The public issue is the closed serializer's title and body and nothing else.
// Before GitHub is called, the intent, the frozen payload with its hash and the target repository are saved. A call
// without a clear answer leaves the feedback "unknown"; the next run first searches that same stored repository for
// the reference, and creates an issue only when the search shows none. A failed or ambiguous search holds it for the
// triager. Publication never reads or changes the status triage sets, and never reads GitHub's issue state back.

/** Queues the operator email inside the statement that settles the publication: the CTEs of the shared mail ledger. */
export type OperatorMail = (notice: OperatorNotice) => SQL;
export type OperatorNotice = {
	tenant: string;
	feedbackId: string;
	reference: string;
	/** The frozen public issue, or null when the fields were not safe to publish. */
	issue: PublicIssue | null;
	url: string | null;
};
export type PublicationConfig = {
	/** The repository a new intent targets. A feedback with an intent keeps the repository it saved. */
	repository: { id: string; name: string };
	issues: IssueClient;
	/** Null when no operator inbox is configured: then no operator email is queued. */
	operatorMail: OperatorMail | null;
};

const feedbackRow = z.object({
	id: z.uuid(),
	account_id: z.uuid(),
	category: z.string(),
	page_address: z.string().nullable(),
	reference: z.string(),
	publication_state: z.enum(["pending", "publishing", "unknown", "published", "held"]),
	publication_payload: z.object({ title: z.string(), body: z.string() }).nullable(),
	repository_name: z.string().nullable(),
});
type Feedback = z.infer<typeof feedbackRow>;
type Outcome =
	| { state: "published"; issue: IssueLink }
	| { state: "held"; reason: HeldReason }
	| { state: "unknown" };

const ACTION = {
	published: "feedback.published",
	held: "feedback.publication_held",
	unknown: "feedback.publication_unknown",
} as const;

/** Saves the intent, frozen payload, hash and target repository with its audit row, before any call. One statement. */
async function intend(tx: Transaction, f: Feedback, issue: PublicIssue, repository: PublicationConfig["repository"]) {
	const r = await tx.execute(sql`WITH upd AS (
 UPDATE feedback SET publication_state='publishing', publication_payload=${JSON.stringify(issue)}::jsonb,
  publication_hash=${issueHash(issue)}, repository_id=${repository.id}::bigint, repository_name=${repository.name}
 WHERE id=${f.id}::uuid AND account_id=${f.account_id}::uuid AND publication_state='pending' RETURNING id, account_id
), aud AS (
 INSERT INTO audit_event (tenant_id, action, kind, subject_id, system_cause, after_value)
 SELECT account_id, 'feedback.publication_intended', 'publish', id, 'feedback_publication',
  jsonb_build_object('state', 'publishing') FROM upd RETURNING 1
) SELECT count(*)::int AS n FROM upd`);
	if (r.rows[0]?.n !== 1) throw Error("feedback_publication_changed");
}

/**
 * Records the outcome with its audit row and, once it is settled (published or held), queues the operator email in the
 * same statement. One statement.
 */
async function settle(tx: Transaction, f: Feedback, outcome: Outcome, mail: OperatorMail | null) {
	const set =
		outcome.state === "published"
			? sql`publication_state='published', issue_number=${outcome.issue.number}::int, issue_url=${outcome.issue.url},
  published_at=clock_timestamp()`
			: outcome.state === "held"
				? sql`publication_state='held', held_reason=${outcome.reason}`
				: sql`publication_state='unknown'`;
	const after =
		outcome.state === "published"
			? { state: "published", issue: outcome.issue.number }
			: outcome.state === "held"
				? { state: "held", reason: outcome.reason }
				: { state: "unknown" };
	const queued =
		mail && outcome.state !== "unknown"
			? sql`, ${mail({
					tenant: f.account_id,
					feedbackId: f.id,
					reference: f.reference,
					issue: f.publication_payload ?? null,
					url: outcome.state === "published" ? outcome.issue.url : null,
				})}`
			: sql``;
	const r = await tx.execute(sql`WITH upd AS (
 UPDATE feedback SET ${set}
 WHERE id=${f.id}::uuid AND account_id=${f.account_id}::uuid AND publication_state IN ('pending', 'publishing', 'unknown')
 RETURNING id, account_id
), aud AS (
 INSERT INTO audit_event (tenant_id, action, kind, subject_id, system_cause, after_value)
 SELECT account_id, ${ACTION[outcome.state]}, 'outcome', id, 'feedback_publication', ${JSON.stringify(after)}::jsonb
 FROM upd RETURNING 1
)${queued} SELECT count(*)::int AS n FROM upd`);
	if (r.rows[0]?.n !== 1) throw Error("feedback_publication_changed");
}

type Step = { f: Feedback; issue: PublicIssue; repository: string; reconcile: boolean };

/** Under the claim and the feedback's row lock: settles what needs no call, or saves the intent and says what to call. */
async function prepare(tx: Transaction, claim: Claim, config: PublicationConfig): Promise<Step | null> {
	if (claim.kind !== "feedback_publication" || !(await lockClaim(tx, claim))) return null;
	const found = await tx.execute(sql`SELECT id, account_id, category, page_address, reference, publication_state,
 publication_payload, repository_name FROM feedback
 WHERE id=${claim.subject_record_id}::uuid AND account_id=${claim.tenant_id}::uuid FOR UPDATE`);
	if (!found.rows[0]) {
		await finishClaim(tx, claim, { state: "cancelled", code: "feedback_removed" });
		return null;
	}
	const f = feedbackRow.parse(found.rows[0]);
	if (f.publication_state === "published" || f.publication_state === "held") {
		await finishClaim(tx, claim, { state: "succeeded" });
		return null;
	}
	if (f.publication_state === "pending") {
		const issue = publicIssue({ category: f.category, address: f.page_address, reference: f.reference });
		if (!issue) {
			await settle(tx, f, { state: "held", reason: "unsafe_fields" }, config.operatorMail);
			await finishClaim(tx, claim, { state: "succeeded" });
			return null;
		}
		await intend(tx, f, issue, config.repository);
		return { f: { ...f, publication_payload: issue }, issue, repository: config.repository.name, reconcile: false };
	}
	// An earlier call may have created the issue: look in the repository the intent saved, never today's.
	return { f, issue: f.publication_payload!, repository: f.repository_name!, reconcile: true };
}

async function call(step: Step, claim: Claim, issues: IssueClient): Promise<Outcome> {
	if (step.reconcile) {
		const found = await issues.search(step.repository, step.f.reference);
		if (found.kind === "failed") return { state: "held", reason: "search_failed" };
		if (found.issues.length > 1) return { state: "held", reason: "ambiguous" };
		if (found.issues.length === 1) return { state: "published", issue: found.issues[0]! };
	}
	const created = await issues.create(step.repository, step.issue);
	if (created.kind === "created") return { state: "published", issue: created.issue };
	if (created.kind === "refused") return { state: "held", reason: "github_refused" };
	// No answer. With attempts left, the next run reconciles; on the last one it stays held for the triager.
	return claim.attempt_count >= claim.max_attempts ? { state: "held", reason: "unresolved" } : { state: "unknown" };
}

async function publish(db: Database, claim: Claim, config: PublicationConfig) {
	const step = await transaction(db, (tx) => prepare(tx, claim, config));
	if (!step) return;
	const outcome = await call(step, claim, config.issues);
	await transaction(db, async (tx) => {
		if (!(await lockClaim(tx, claim))) return;
		await settle(tx, step.f, outcome, config.operatorMail);
		await finishClaim(
			tx,
			claim,
			outcome.state === "unknown" ? { state: "retry_wait", code: "github_unknown" } : { state: "succeeded" },
		);
	});
}

/**
 * One bounded batch of feedback publication: returns expired leases to the queue, then claims and publishes due
 * feedback one at a time, starting none after `until`. Returns how many it claimed.
 */
export async function runDueFeedbackPublication(
	db: Database,
	config: PublicationConfig,
	limit: number,
	until: number,
): Promise<number> {
	await recoverLease(db);
	let claimed = 0;
	while (claimed < limit && Date.now() < until) {
		const [claim] = await claimDue(db, ["feedback_publication"], 1);
		if (!claim) break;
		claimed++;
		// A failed run keeps its lease; lease recovery returns it to the queue. No error text: it can carry values.
		await publish(db, claim, config).catch(() =>
			console.error(JSON.stringify({ component: "feedback-publication", outcome: "error" })),
		);
	}
	return claimed;
}
