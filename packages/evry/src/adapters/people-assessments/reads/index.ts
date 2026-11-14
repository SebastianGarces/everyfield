import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import {
	assessments,
	commitments,
	interviews,
	PeopleReadContext,
	peopleMerge,
	peopleUnmerge,
	recordCorrections,
} from "@everyfield/domain/people";
import {
	counted,
	interviewCriteria,
	listText,
	mergeBlockedText,
	unmergeBlockedText,
	type PeopleReply,
} from "@everyfield/contracts/people";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { personRow } from "../../../catalog/person-row.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { ownerOrAdmin } from "../../people/commands/index.ts";
import { id } from "../ids.ts";

// The People assessment-area reads (WP-061): interviews, 4 C's assessments, commitments and their document, merge and
// Unmerge reviews, record corrections and where a merged person went. Each calls the native People read the screens
// use, under the same domain authority (Owner or Admin, checked live inside its statement, C13). A Member, an
// organization seat or another church gets no tool here at all, so nothing in these results can reach them. These are
// recorded human judgments: the rows carry exactly what a person recorded and nothing the model could score.

const context = (actor: EvryActor) => new PeopleReadContext(actor.authority);
const result = (operation: string, rows: SourceRow[], exclusions: string[], total = rows.length): SourceResult => ({
	operation,
	status: rows.length ? "available" : "not_found",
	rows,
	total,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions,
});
/** A native read's value, or nothing: a foreign, retired or guessed id reads the same as one that never existed. */
const valueOf = <T>(reply: PeopleReply<T>) => (reply.status === "ok" ? reply.value : null);
const PRIVATE = ["private care", "other churches"];

const personInput = z.strictObject({ personId: id });
const history = z.strictObject({
	personId: id,
	page: z.int().min(1).max(1000).optional().describe("Page number of a previous result's next page"),
});
const page = (input: z.infer<typeof history>) => ({ personId: input.personId, page: input.page ?? 1, limit: 24 });
const paged = (operation: string, rows: SourceRow[], h: { total: number; next: number | null }, p: number) => ({
	...result(operation, rows, PRIVATE, h.total),
	page: p,
	next: h.next,
	completeness: h.next === null ? ("complete" as const) : ("partial" as const),
});

export const getInterviews: ReadAdapter<z.infer<typeof history>> = {
	operation: "people.getInterviews",
	description:
		"Read one person's recorded interviews, latest first: the date, the five criteria (maturity, gifted, chemistry, right reasons, season) each rated pass, concern or fail with notes, the result and next steps. Owners and Admins only.",
	input: history,
	allowed: ownerOrAdmin,
	async invoke(tx: Transaction, actor, input) {
		const v = valueOf(await interviews.getInterviews(tx, context(actor), page(input)));
		if (!v) return result("people.getInterviews", [], PRIVATE);
		const rows = v.items.map((i): SourceRow => ({
			kind: "record",
			id: i.id,
			label: `Interview on ${i.occurredOn}`,
			fields: {
				record: "interview",
				personId: i.personId,
				occurredOn: i.occurredOn,
				...Object.fromEntries(
					interviewCriteria.flatMap((k) => [
						[k, i[k].rating],
						[`${k}Notes`, i[k].notes],
					]),
				),
				result: i.result,
				nextSteps: i.nextSteps,
			},
		}));
		return paged("people.getInterviews", rows, v, input.page ?? 1);
	},
};

export const getAssessments: ReadAdapter<z.infer<typeof history>> = {
	operation: "people.getAssessments",
	description:
		"Read one person's recorded 4 C's assessments, latest first: the date, the committed, compelled, contagious and courageous scores (1 to 5) with notes, and their total. Owners and Admins only.",
	input: history,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input) {
		const v = valueOf(await assessments.getAssessments(tx, context(actor), page(input)));
		if (!v) return result("people.getAssessments", [], PRIVATE);
		const rows = v.items.map((a): SourceRow => ({
			kind: "record",
			id: a.id,
			label: `4 C's on ${a.occurredOn}`,
			fields: {
				record: "assessment",
				personId: a.personId,
				occurredOn: a.occurredOn,
				...Object.fromEntries(
					(["committed", "compelled", "contagious", "courageous"] as const).flatMap((k) => [
						[k, String(a[k].score)],
						[`${k}Notes`, a[k].notes],
					]),
				),
				total: String(a.total),
			},
		}));
		return paged("people.getAssessments", rows, v, input.page ?? 1);
	},
};

export const getCommitments: ReadAdapter<z.infer<typeof history>> = {
	operation: "people.getCommitments",
	description:
		"Read one person's commitment: whether it is active, withdrawn or unknown and since when, then each signed card latest first with its kind, signed date, witness, notes and whether a signed document is on file. Owners and Admins only.",
	input: history,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input) {
		const v = valueOf(await commitments.getCommitments(tx, context(actor), page(input)));
		if (!v) return result("people.getCommitments", [], PRIVATE);
		const current: SourceRow = {
			kind: "record",
			id: v.personId,
			label: "Current commitment",
			fields: {
				record: "commitment_status",
				state: v.current.state,
				effectiveOn: v.current.effectiveOn,
				firstSignedOn: v.firstAcquisition.status === "known" ? v.firstAcquisition.occurredOn : null,
			},
		};
		const cards = v.items.map((k): SourceRow => ({
			kind: "record",
			id: k.id,
			label: `${k.kind === "core_group" ? "Core group" : "Launch team"} commitment signed ${k.occurredOn}`,
			fields: {
				record: "commitment",
				personId: k.personId,
				kind: k.kind,
				occurredOn: k.occurredOn,
				witness: k.witness
					? k.witness.kind === "person"
						? (v.witnessNames[k.witness.personId] ?? "A former person")
						: k.witness.text
					: null,
				notes: k.notes,
				document: k.document.status,
				voided: k.voidedAt !== null,
			},
		}));
		return { ...paged("people.getCommitments", [current, ...cards], v, input.page ?? 1), total: v.total };
	},
};

const documentRow = z.object({ person_id: z.uuid(), media_type: z.string(), byte_count: z.coerce.number() });
export const getCommitmentDownload: ReadAdapter<{ commitmentId: string }> = {
	operation: "people.getCommitmentDownload",
	description:
		"Get the download link for one commitment card's signed document, by the card id from people.getCommitments. The link opens the same file the People page gives. Owners and Admins only.",
	input: z.strictObject({ commitmentId: id }),
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input) {
		// The link is the People page's own document route: each time it is opened it calls the native
		// people.getCommitmentDownload under that request's live authority, which signs a five-minute link to the exact
		// object. No signed link, storage key or byte reaches the model. This statement finds the card's document under
		// the same live Owner or Admin check the native read uses.
		const r = await tx.execute(sql`SELECT k.person_id,f.media_type,f.byte_count FROM commitment k
			JOIN file_object f ON f.id=k.object_id AND f.tenant_id=k.plant_id AND f.state='ready'
			WHERE k.id=${input.commitmentId}::uuid AND k.plant_id=${actor.owner.id}::uuid
				AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined }, true)}`);
		const found = r.rows[0] ? documentRow.parse(r.rows[0]) : null;
		if (!found) return result("people.getCommitmentDownload", [], ["document bytes"]);
		const row: SourceRow = {
			// A record row, so it is withheld with the rest of the assessment area once the seat is no longer Owner or Admin.
			kind: "record",
			id: input.commitmentId,
			label: "Signed commitment document",
			fields: {
				record: "commitment_document",
				href: `/people/${found.person_id}/commitments/${input.commitmentId}/document`,
				mediaType: found.media_type,
				byteCount: String(found.byte_count),
			},
		};
		return result("people.getCommitmentDownload", [row], ["document bytes", "signed storage links"]);
	},
};

const names = async (tx: Transaction, actor: EvryActor, ids: string[]) => {
	const r = await tx.execute(sql`SELECT p.id,p.display_name FROM person p
		WHERE p.id=ANY(${sql.param(ids)}::uuid[]) AND p.tenant_id=${actor.owner.id}::uuid AND p.plant_id=${actor.owner.id}::uuid`);
	return new Map(r.rows.map((x) => [String(x.id), String(x.display_name)]));
};

/**
 * The merge review of two people, through the native people.getMergeReview. `blocked` is the same answer the People
 * merge review gives; it is null when the merge can run.
 */
export async function mergeReviewOf(tx: Transaction, actor: EvryActor, pair: { sourceId: string; survivorId: string }) {
	return valueOf(await peopleMerge.getMergeReview(tx, context(actor), pair));
}
export const getMergeReview: ReadAdapter<{ sourceId: string; survivorId: string }> = {
	operation: "people.getMergeReview",
	description:
		"Review a merge of two people in this church before proposing it: which record stays (survivorId), which merges into it (sourceId), the details that differ, what moves, the stage kept and anything that blocks the merge. When the user does not say which stays, do not ask: for a pair from people.listDuplicatePairs the imported person merges into the person they may duplicate; otherwise keep either one and say which stays, since the review shows it. Owners and Admins only.",
	input: z.strictObject({ sourceId: id, survivorId: id }),
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input) {
		if (input.sourceId === input.survivorId) throw new EvryRefusal("invalid_input");
		const v = await mergeReviewOf(tx, actor, input);
		if (!v) return result("people.getMergeReview", [], PRIVATE);
		const who = { source: v.source.displayName, survivor: v.survivor.displayName };
		const moves = v.references.filter((r) => r.treatment === "move" || r.treatment === "deduplicate");
		const stays = v.references.filter((r) => r.treatment === "keep");
		const blocked = v.blockers.causes.length ? mergeBlockedText(v.blockers, who) : null;
		const rows: SourceRow[] = [
			personRow(actor, v.survivor.personId, v.survivor.displayName, { role: "stays" }),
			personRow(actor, v.source.personId, v.source.displayName, { role: "merges in" }),
			{
				kind: "merge",
				id: v.source.personId,
				label: `Merge ${v.source.displayName} into ${v.survivor.displayName}`,
				fields: {
					differingDetails: v.fields.map((f) => f.field).join(", ") || null,
					moves: listText(moves.map((r) => counted(r.kind, r.count))) || null,
					staysWithMergedRecord: listText(stays.map((r) => counted(r.kind, r.count))) || null,
					stageKept: v.stage?.result ?? null,
					blocked,
				},
			},
		];
		return result("people.getMergeReview", rows, PRIVATE);
	},
};

/** The Unmerge preview, with the names of both people, through the native people.previewUnmerge. */
export async function unmergePreviewOf(tx: Transaction, actor: EvryActor, mergeId: string) {
	const v = valueOf(await peopleUnmerge.previewUnmerge(tx, context(actor), { mergeId }));
	if (!v) return null;
	const named = await names(tx, actor, [v.sourceId, v.survivorId]);
	const who = {
		source: named.get(v.sourceId) ?? "The merged person",
		survivor: named.get(v.survivorId) ?? "The kept person",
	};
	const blocked =
		v.state === "unmerged"
			? "This merge was already undone."
			: v.conflicts.length
				? unmergeBlockedText(v.conflicts, who)
				: null;
	return { ...v, names: who, blocked };
}
const unmergeInput = z.union([
	z.strictObject({ mergeId: id }),
	z.strictObject({ personId: id.describe("Either person of the merge: the one who stayed or the one merged in") }),
]);
/**
 * The merge a person took part in that can still be undone, latest first, under the live Owner or Admin check: a later
 * turn knows the people by name, not the merge's id.
 */
async function mergeOf(tx: Transaction, actor: EvryActor, input: z.infer<typeof unmergeInput>) {
	if ("mergeId" in input) return input.mergeId;
	const r = await tx.execute(sql`SELECT m.id FROM person_merge m
		WHERE (m.survivor_id=${input.personId}::uuid OR m.source_id=${input.personId}::uuid) AND m.tenant_id=${actor.owner.id}::uuid
			AND m.unmerged_at IS NULL
			AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined }, true)}
		ORDER BY m.merged_at DESC,m.id DESC LIMIT 1`);
	return r.rows[0] ? String(r.rows[0].id) : null;
}
export const previewUnmerge: ReadAdapter<z.infer<typeof unmergeInput>> = {
	operation: "people.previewUnmerge",
	description:
		"Preview undoing a merge, by its mergeId or by either person in it (the latest merge that is not undone): who comes back, what moves back, and whether anything changed since that stops the Unmerge. Owners and Admins only.",
	input: unmergeInput,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input) {
		const mergeId = await mergeOf(tx, actor, input);
		const v = mergeId ? await unmergePreviewOf(tx, actor, mergeId) : null;
		if (!v) return result("people.previewUnmerge", [], PRIVATE);
		const row: SourceRow = {
			kind: "merge",
			id: v.mergeId,
			label: `Merge of ${v.names.source} into ${v.names.survivor}`,
			fields: {
				mergeId: v.mergeId,
				state: v.state,
				mergedAt: v.mergedAt,
				comesBack: v.names.source,
				movesBack: listText(v.restores.map((r) => counted(r.kind, r.count))) || null,
				detailsGoBack: v.fields.join(", ") || null,
				blocked: v.blocked,
			},
		};
		return result("people.previewUnmerge", [row], PRIVATE);
	},
};

const correctionsInput = z.strictObject({
	personId: id,
	recordId: id.optional().describe("Only this interview, assessment or commitment card"),
});
export const listRecordCorrections: ReadAdapter<z.infer<typeof correctionsInput>> = {
	operation: "people.listRecordCorrections",
	description:
		"Read the correction history of one person's interviews, 4 C's assessments and commitment cards, latest first: each corrected field with its old and new value, and the reason. Owners and Admins only.",
	input: correctionsInput,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input) {
		const v = valueOf(
			await recordCorrections.listRecordCorrections(tx, context(actor), { ...input, page: 1, limit: 24 }),
		);
		if (!v) return result("people.listRecordCorrections", [], PRIVATE);
		const rows = v.items.map((c): SourceRow => ({
			kind: "correction",
			id: c.id,
			label: `${c.recordType} corrected ${c.correctedAt.slice(0, 10)}`,
			fields: {
				recordType: c.recordType,
				recordId: c.recordId,
				correctedAt: c.correctedAt,
				reason: c.reason,
				// Each corrected field with its old and new value, as the record held them.
				changes: JSON.stringify(c.changes),
			},
		}));
		return { ...result("people.listRecordCorrections", rows, PRIVATE, v.total), next: v.next };
	},
};

export const mergedPersonDestination: ReadAdapter<z.infer<typeof personInput>> = {
	operation: "people.mergedPersonDestination",
	description:
		"Say where a person's record leads now: live, removed, or merged into another person, with the mergeId of a merge that can still be undone. Owners and Admins only.",
	input: personInput,
	// The People pages let any reader follow a merged person; in Evry it opens the merge area, so Owners and Admins only.
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input) {
		const v = valueOf(await peopleMerge.mergedPersonDestination(tx, context(actor), input));
		if (!v) return result("people.mergedPersonDestination", [], []);
		const row: SourceRow = {
			kind: "merge",
			id: v.mergeId ?? v.personId,
			label: v.status === "merged" ? "Merged person" : "Person",
			fields: { personId: v.personId, status: v.status, destinationId: v.destinationId, mergeId: v.mergeId },
		};
		return result("people.mergedPersonDestination", [row], []);
	},
};

/** The installed assessment-area read tools, in catalog order. */
export const ASSESSMENT_READS = [
	getInterviews,
	getAssessments,
	getCommitments,
	getCommitmentDownload,
	getMergeReview,
	previewUnmerge,
	listRecordCorrections,
	mergedPersonDestination,
] as const;
