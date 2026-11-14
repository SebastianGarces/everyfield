import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import type { discoveryProfileResult, resumeResult } from "@everyfield/contracts/onboarding";
import { readOnboardingEntry } from "@everyfield/domain/onboarding";
import { z } from "zod";
import foundations from "../../../../../../docs/reference/discovery-foundations.json" with { type: "json" };
import type { EvryActor } from "../../../context/actor.ts";
import type { NativePorts } from "../../../proposals/types.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { phaseText, SHARING_CATEGORIES, SHARING_CATEGORY_LABEL } from "../../../catalog/labels.ts";
import { liveAuthority } from "../../../context/authority.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { accountContext, plantOwner } from "../../native.ts";

// Where setup stands, read through the same native reads `/onboarding` uses: a church's setup steps for the Owner who is
// setting it up, and an account's own Discovery space. Each row is one step or one organization, worded as the
// onboarding screen words it.

type Resume = Extract<z.infer<typeof resumeResult>, { status: "available" }>;
type Profile = Extract<z.infer<typeof discoveryProfileResult>, { status: "active" }>["profile"];

const result = (operation: string, rows: SourceRow[], facts: SourceResult["facts"]): SourceResult => ({
	operation,
	status: "available",
	rows,
	total: rows.length,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: [],
	facts,
});
const none = (operation: string, why: string): SourceResult => ({
	operation,
	status: "not_found",
	rows: [],
	total: 0,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: [why],
});
/**
 * Where this account stands, from the one read `/onboarding` makes (readOnboardingEntry): a church's setup for the Owner
 * setting it up, or the account's own Discovery space. The read takes no lock and checks live access itself.
 */
async function entry(tx: Transaction, actor: EvryActor, native: NativePorts | null) {
	if (!native) throw new EvryRefusal("source_unavailable");
	const session = {
		status: "active" as const,
		accountId: actor.accountId,
		sessionId: actor.session,
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	};
	return readOnboardingEntry(tx as unknown as Database, native.onboarding, session as never, actor.authority, true);
}

const step = (id: string, label: string, saved: boolean, answer: string | null): SourceRow => ({
	kind: "step",
	id,
	label,
	fields: { status: saved ? "saved" : "open", answer },
});
/** A journey answer other than a declared phase, as `/onboarding` words it. */
export const JOURNEY_TEXT = {
	unsure: "Not sure yet. Nothing declared.",
	discerning: "Still discerning. Nothing declared.",
	skip: "Skipped",
} as const;
/** The answer each step shows on `/onboarding`, or null while it is open. */
function journeyAnswer(r: Resume) {
	if (r.journey.status !== "saved") return null;
	const j = r.journey.value;
	return j.answer === "existing" ? `Declared ${phaseText(j.phase)}. It can't be changed in setup.` : JOURNEY_TEXT[j.answer];
}
function launchAnswer(r: Resume) {
	if (r.launch.status !== "saved") return null;
	if (r.scheduledLaunchDate) return `Launch date ${r.scheduledLaunchDate}`;
	return r.launch.value.answer === "skip" ? "Skipped" : "No date yet";
}
function leadAnswer(r: Resume) {
	const lead = r.lead;
	if (lead.answer === "pending") return null;
	if (lead.answer === "yes")
		return lead.seniorPastor === "filled" ? "You hold the Senior pastor role" : "You hold the lead role";
	return lead.answer === "no" ? "Someone else leads" : "Skipped";
}
/** The setup steps of `/onboarding` in its order, each saved or open. */
export function setupSteps(r: Resume): SourceRow[] {
	const plant = r.plant.id;
	return [
		step(`${plant}:journey`, "Where you are", r.journey.status === "saved", journeyAnswer(r)),
		step(`${plant}:launch`, "Launch date", r.launch.status === "saved", launchAnswer(r)),
		step(`${plant}:team`, "Your team", r.lead.answer !== "pending", leadAnswer(r)),
		step(
			`${plant}:finish`,
			"Finish setup",
			r.completion.status === "completed",
			r.completion.status === "completed" ? "Finished" : null,
		),
	];
}

/** Where a returning Owner picks up on `/onboarding`: the first open step, or Finish (model.ts resumeStep). */
export function resumeAt(r: Resume) {
	if (r.completion.status === "completed") return "Finish setup";
	if (r.journey.status !== "saved" || r.launch.status !== "saved") return "Where you are";
	return r.lead.answer === "pending" ? "Your team" : "Finish setup";
}

export const ONBOARDING_READS = [
	{
		operation: "onboarding.getResume",
		description:
			"Where setup of this church stands, for the Owner who is setting it up: each step (where you are, launch date, your team, finish) saved or open, the step setup picks up at, the current phase, the launch date, and when the user's Discovery space closed if it became this church",
		input: z.strictObject({}),
		allowed: plantOwner,
		async invoke(tx, actor, _input, native): Promise<SourceResult> {
			const found = await entry(tx, actor, native);
			if (found.kind !== "plant") return none("onboarding.getResume", "This church has no setup in progress for you.");
			const resume = found.resume as Resume;
			// The user's own Discovery space that became this church, which closed when it did.
			const [closed] = (
				await tx.execute(sql`SELECT to_char(d.converted_at AT TIME ZONE pl.timezone,'YYYY-MM-DD') AS on
					FROM discovery d JOIN plant pl ON pl.id=d.converted_plant_id
					WHERE d.account_id=${actor.accountId}::uuid AND d.converted_plant_id=${actor.owner.id}::uuid AND ${liveAuthority(actor)}`)
			).rows as { on: string }[];
			return result("onboarding.getResume", setupSteps(resume), {
				church: found.plantName,
				phase: phaseText(resume.currentPhase),
				launchDate: resume.scheduledLaunchDate,
				resumeAt: resumeAt(resume),
				finished: resume.completion.status === "completed",
				discoveryClosedOn: closed?.on ?? null,
			});
		},
	} satisfies ReadAdapter<Record<string, never>>,
	{
		operation: "discovery.getProfile",
		description:
			"The signed-in account's own Discovery space: the sending churches and networks it is linked to, what each link shares, and how many foundation articles it has read. It never shows another account's space",
		input: z.strictObject({}),
		allowed: accountContext,
		async invoke(tx, actor, _input, native): Promise<SourceResult> {
			const found = await entry(tx, actor, native);
			if (found.kind !== "discovery") return none("discovery.getProfile", "This account has no Discovery space.");
			const profile = found.profile as Profile;
			const ids = profile.relationships.map((r) => r.organization.id);
			const names = new Map(
				(
					(
						await tx.execute(sql`SELECT o.id::text AS id, o.name FROM organization o WHERE o.id=ANY(${sql.param(ids)}::uuid[])
							AND ${liveAuthority(actor)}`)
					).rows as { id: string; name: string }[]
				).map((o) => [o.id, o.name]),
			);
			const rows: SourceRow[] = profile.relationships.map((r) => ({
				kind: "relationship",
				id: r.relationshipId,
				label: names.get(r.organization.id) ?? "Organization",
				fields: {
					organizationId: r.organization.id,
					relationship: r.organization.organizationKind === "sending_network" ? "Network" : "Sending church",
					// What the link shares, in the Sharing screen's words, or null when it shares nothing.
					shares:
						SHARING_CATEGORIES.filter((k) => r.choices[k])
							.map((k) => SHARING_CATEGORY_LABEL[k])
							.join(", ") || null,
				},
			}));
			return result("discovery.getProfile", rows, {
				foundationsRead: profile.reading.articles.length,
				foundationsTotal: foundations.article_count,
			});
		},
	} satisfies ReadAdapter<Record<string, never>>,
] as const;
