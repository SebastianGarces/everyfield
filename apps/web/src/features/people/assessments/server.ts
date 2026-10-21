import "server-only";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { Transaction } from "@everyfield/db/client";
import { assessments, commitments, interviews } from "@everyfield/domain/people";
import type { PersonRecords } from "./model.ts";

/** Records per history page. The first page loads with the person page; "Show earlier" reads the next one. */
export const HISTORY_PAGE = 10;

/**
 * The person's 4 C's, interviews and commitments, read in the person page's own transaction: one statement each,
 * whatever the number of records (REQ-PPL-012, 013, 014). Only an Owner or Admin reads them; the page does not ask for
 * anyone else. A part that is refused or fails reads as null, so the rest of the page still shows.
 */
export async function readPersonRecords(tx: Transaction, ctx: PeopleContext, personId: string): Promise<PersonRecords> {
	const request = { personId, limit: HISTORY_PAGE, page: 1 };
	const a = await assessments.getAssessments(tx, ctx, request);
	const i = await interviews.getInterviews(tx, ctx, request);
	const k = await commitments.getCommitments(tx, ctx, request);
	return {
		assessments: a.status === "ok" ? a.value : null,
		interviews: i.status === "ok" ? i.value : null,
		commitments: k.status === "ok" ? k.value : null,
	};
}
