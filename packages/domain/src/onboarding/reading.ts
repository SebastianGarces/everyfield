import "server-only";
import { and, eq, inArray, isNotNull } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import * as c from "@everyfield/contracts/onboarding";
import { owner } from "@everyfield/contracts/common";
import foundations from "../../../../docs/reference/discovery-foundations.json" with { type: "json" };
import type { Tx } from "./core.ts";

/** The foundation articles' ids, for a read that selects their readings. */
export const foundationArticles = foundations.articles.map((a) => a.id);
async function readingRows(tx: Tx, accounts: readonly string[]) {
	const rows = await tx
		.select({
			reading: t.reading,
			source: {
				id: t.article_revision.id,
				article_id: t.article_revision.article_id,
				tenant_id: t.article_revision.tenant_id,
				revision_number: t.article_revision.revision_number,
			},
			kind: t.tenant.kind,
			organizationKind: t.organization.kind,
		})
		.from(t.reading)
		.innerJoin(
			t.article_revision,
			and(
				eq(t.article_revision.id, t.reading.completed_revision_id),
				eq(t.article_revision.article_id, t.reading.article_id),
			),
		)
		.innerJoin(t.tenant, eq(t.tenant.id, t.article_revision.tenant_id))
		.leftJoin(t.organization, eq(t.organization.id, t.tenant.id))
		.where(
			and(
				inArray(t.reading.account_id, [...accounts]),
				inArray(
					t.reading.article_id,
					foundations.articles.map((a) => a.id),
				),
				isNotNull(t.article_revision.published_at),
				isNotNull(t.reading.completed_at),
			),
		);
	return rows;
}
/** One completed reading with its published source, from readingRows or the one-statement entry read. */
export type ReadingRow = {
	reading: { account_id: string; article_id: string; completed_fraction: string | null; completed_at: Date | null };
	source: { id: string; tenant_id: string; revision_number: number | string };
	kind: string;
	organizationKind: string | null;
};
function readingValue(accountId: string, rows: readonly ReadingRow[]) {
	return c.ownDiscoveryReading.parse({
		readerAccountId: accountId,
		articles: rows
			.filter((r) => r.reading.account_id === accountId)
			.map(({ reading: r, source: s, kind, organizationKind }) => ({
				readerAccountId: accountId,
				articleId: r.article_id,
				source: {
					owner: owner.parse({ kind, id: s.tenant_id, ...(kind === "organization" ? { organizationKind } : {}) }),
					publishedRevisionId: s.id,
					revision: String(s.revision_number),
				},
				scrollRatio: Number(r.completed_fraction),
				readAt: r.completed_at!.toISOString(),
			})),
	});
}
export async function ownReading(tx: Tx, accountId: string) {
	return readingValue(accountId, await readingRows(tx, [accountId]));
}

/** The plant's foundation reading from its current Owner and Admin lead candidates and their completed readings. */
export function readingFrom(
	plantId: string,
	candidates: readonly { accountId: string; role: string; personId: string | null; lead: boolean }[],
	rows: readonly ReadingRow[],
) {
	for (const candidate of candidates) {
		let eligibility;
		if (candidate.role === "owner") eligibility = { kind: "current_owner" };
		else if (candidate.role === "admin" && candidate.personId && candidate.lead)
			eligibility = { kind: "current_admin_lead", personId: candidate.personId };
		if (!eligibility) continue;
		const reading = readingValue(candidate.accountId, rows);
		if (reading.articles.length === foundations.article_count && reading.articles.every((a) => a.scrollRatio > 0.8))
			return c.foundationReading.parse({
				status: "complete",
				plant: { kind: "plant", id: plantId },
				readerAccountId: candidate.accountId,
				eligibility,
				articles: reading.articles,
			});
	}
	return c.foundationReading.parse({ status: "incomplete" });
}
