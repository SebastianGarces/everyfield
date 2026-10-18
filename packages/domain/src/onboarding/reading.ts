import "server-only";
import { and, eq, inArray, isNotNull, isNull, lte, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import * as c from "@everyfield/contracts/onboarding";
import { owner } from "@everyfield/contracts/common";
import foundations from "../../../../docs/reference/discovery-foundations.json" with { type: "json" };
import { liveOwner } from "../access/session.ts";
import type { Tx } from "./core.ts";

export async function ownReading(tx: Tx, accountId: string) {
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
				eq(t.reading.account_id, accountId),
				inArray(
					t.reading.article_id,
					foundations.articles.map((a) => a.id),
				),
				isNotNull(t.article_revision.published_at),
				isNotNull(t.reading.completed_at),
			),
		);
	return c.ownDiscoveryReading.parse({
		readerAccountId: accountId,
		articles: rows.map(({ reading: r, source: s, kind, organizationKind }) => ({
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
export async function plantReading(tx: Tx, plantId: string) {
	const [setup] = await tx
		.select({ lead: t.onboarding_setup.lead })
		.from(t.onboarding_setup)
		.where(eq(t.onboarding_setup.plant_id, plantId));
	const lead = c.leadSetup.parse(setup?.lead ?? { answer: "pending" });
	const candidates = await tx
		.select({ accountId: t.seat.account_id, role: t.seat.role, personId: t.person.id })
		.from(t.seat)
		.innerJoin(t.account, and(eq(t.account.id, t.seat.account_id), eq(t.account.registration_state, "active")))
		.leftJoin(
			t.person,
			and(
				eq(t.person.linked_account_id, t.seat.account_id),
				eq(t.person.plant_id, plantId),
				eq(t.person.state, "live"),
			),
		)
		.where(and(eq(t.seat.plant_id, plantId), isNull(t.seat.ended_at), lte(t.seat.accepted_at, sql`clock_timestamp()`)));
	for (const candidate of candidates) {
		if (!(await liveOwner(tx, owner.parse({ kind: "account", id: candidate.accountId })))) continue;
		const revoked = await tx
			.select({ id: t.lifecycle_witness.id })
			.from(t.lifecycle_witness)
			.innerJoin(t.seat, eq(t.seat.id, t.lifecycle_witness.seat_id))
			.where(
				and(
					eq(t.seat.account_id, candidate.accountId),
					sql`${t.lifecycle_witness.state} NOT IN ('active','cancelled')`,
				),
			);
		if (revoked.length) continue;
		let eligibility;
		if (candidate.role === "owner") eligibility = { kind: "current_owner" };
		else if (candidate.role === "admin" && candidate.personId) {
			const assignment = await tx
				.select({ id: t.team_tenure.id })
				.from(t.team_tenure)
				.innerJoin(t.team_role, and(eq(t.team_role.id, t.team_tenure.role_id), eq(t.team_role.plant_id, plantId)))
				.innerJoin(t.team, and(eq(t.team.id, t.team_role.team_id), eq(t.team.plant_id, plantId)))
				.where(
					and(
						eq(t.team_tenure.person_id, candidate.personId),
						eq(t.team_tenure.plant_id, plantId),
						isNull(t.team_tenure.ended_on),
						eq(t.team_role.leadership, true),
						eq(t.team_role.id, lead.answer === "yes" ? lead.assignment.roleId : "00000000-0000-0000-0000-000000000000"),
						isNull(t.team_role.retired_at),
						isNull(t.team.archived_at),
					),
				);
			if (assignment.length) eligibility = { kind: "current_admin_lead", personId: candidate.personId };
		}
		if (!eligibility) continue;
		const reading = await ownReading(tx, candidate.accountId);
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
