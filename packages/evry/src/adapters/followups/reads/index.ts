import { followUpReader } from "@everyfield/domain/followups";
import {
	followUpCoverageRequest,
	listContactHistoryRequest,
	listFollowUpOwnersRequest,
	planHandoffRequest,
	readObligationsRequest,
} from "@everyfield/contracts/followups";
import type { Due } from "@everyfield/contracts/tasks";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { personRow } from "../../../catalog/person-row.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { dueText, inPlant, ownerNames, ownerOrAdmin, result, value } from "../../tasks/reads/index.ts";

// The Follow-up read tools (WP-067): obligations, owners, coverage and the recorded contact log, through the native
// follow-up reads the Follow-ups page uses. A recorded outcome is what a person said happened: only an effective
// "contacted" outcome is a conversation that happened (COM-011). An attempt, an administrative completion and "no
// longer needed" stay distinct, and a missing record never proves that nobody called. Sent emails are not in this log.

type Owner = { accountId: string; displayName: string; eligible: boolean };
/** The owners who may own the follow-up now; none means it needs an owner (REQ-TSK-012). */
const owning = (owners: readonly Owner[]) => owners.filter((o) => o.eligible);
type Duty = {
	taskId: string;
	revision: string;
	title: string;
	status: string;
	due: Due;
	overdue: boolean | null;
	obligationId: string | null;
	person: { id: string; label: string };
	owners: Owner[];
	origin: { kind: "meeting"; meeting: { label: string } } | { kind: "added"; by: string | null };
	lastOutcome: string | null;
	contacted: { at: string; by: string | null } | null;
};
/** One open follow-up task: the person it is for, its owners and its latest recorded outcome. */
function dutyRow(actor: EvryActor, d: Duty): SourceRow {
	const owners = owning(d.owners);
	return {
		kind: "follow_up",
		id: d.taskId,
		label: d.person.label,
		fields: {
			personId: d.person.id,
			title: d.title,
			status: d.status,
			owners: ownerNames(actor, owners),
			needsOwner: owners.length === 0,
			due: dueText(d.due),
			overdue: d.overdue,
			from: d.origin.kind === "meeting" ? `meeting: ${d.origin.meeting.label}` : "added by hand",
			lastOutcome: d.lastOutcome,
			contactedAt: d.contacted?.at ?? null,
			contactedBy: d.contacted?.by ?? null,
			obligationId: d.obligationId,
			revision: d.revision,
		},
	};
}

const page = {
	page: z.int().min(1).max(1000).optional(),
	limit: z.int().min(1).max(100).optional(),
};
const ownersInput = z.strictObject({
	personId: z.uuid().optional().describe("Only this person's open follow-ups"),
	owner: z
		.union([z.uuid(), z.literal("needs_owner")])
		.optional()
		.describe("An account id from tasks.eligibleAssignees, or needs_owner"),
	...page,
});
export const listFollowUpOwners: ReadAdapter<z.infer<typeof ownersInput>> = {
	operation: "tasks.listFollowUpOwners",
	description:
		"List open person follow-ups with who owns each, as the Follow-ups page does: by person, by owner or those needing an owner. Each row has the person, owners (empty means nobody is assigned), due date, where it came from and the latest recorded outcome.",
	input: ownersInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const found = value(
			await followUpReader.listFollowUpOwners(
				tx,
				actor.authority,
				listFollowUpOwnersRequest.parse({ ...input, limit: input.limit ?? 50 }),
			),
		);
		return result(
			"tasks.listFollowUpOwners",
			found.items.map((d) => dutyRow(actor, d)),
			["completed or closed follow-ups", "contact notes"],
			{ total: found.matched, page: found.page, next: found.next },
		);
	},
};

const coverageInput = z.strictObject({
	personId: z.uuid().optional(),
	coverage: z.enum(["owned", "needs_owner", "uncovered", "any"]).optional(),
	...page,
});
export const followUpCoverage: ReadAdapter<z.infer<typeof coverageInput>> = {
	operation: "tasks.followUpCoverage",
	description:
		"List people who are not yet committed with their follow-up coverage: owned (someone holds an open follow-up), needs_owner (an open follow-up nobody can own) or uncovered (no open follow-up, which is not urgent by itself).",
	input: coverageInput,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const found = value(
			await followUpReader.followUpCoverage(
				tx,
				actor.authority,
				followUpCoverageRequest.parse({ ...input, limit: input.limit ?? 50 }),
			),
		);
		return result(
			"tasks.followUpCoverage",
			found.items.map((p) =>
				personRow(actor, p.person.id, p.person.label, {
					stage: p.person.stage,
					coverage: p.coverage,
					owners:
						[...new Set(p.duties.flatMap((d) => owning(d.owners).map((o) => ownerNames(actor, [o])!)))].join(", ") ||
						null,
				}),
			),
			["committed people", "contact notes"],
			{ total: found.total, page: found.page, next: found.next },
		);
	},
};

const handoffInput = z.strictObject({ fromAccountId: z.uuid().describe("An account id from tasks.eligibleAssignees") });
export const planHandoff: ReadAdapter<z.infer<typeof handoffInput>> = {
	operation: "tasks.planHandoff",
	description:
		"Preview handing one account's open follow-ups to someone else: their follow-ups, and the accounts that could take them. Changes nothing.",
	input: handoffInput,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const plan = value(await followUpReader.planHandoff(tx, actor.authority, planHandoffRequest.parse(input)));
		return result(
			"tasks.planHandoff",
			[
				...plan.duties.slice(0, 100).map((d) => dutyRow(actor, d)),
				...plan.recipients.map((r) => ({
					kind: "account" as const,
					id: r.accountId,
					label: r.displayName,
					fields: { canTakeThem: true, ...(r.accountId === actor.accountId ? { you: true } : {}) },
				})),
			],
			["contact notes"],
			{ total: plan.total, completeness: plan.total > 100 ? "partial" : "complete" },
		);
	},
};

const obligationsInput = z.strictObject({
	personId: z.uuid().optional(),
	meetingId: z.uuid().optional(),
	state: z.enum(["open", "complete", "no_longer_needed", "superseded", "any"]).optional(),
	...page,
});
export const readObligations: ReadAdapter<z.infer<typeof obligationsInput>> = {
	operation: "followups.readObligations",
	description:
		"Read the follow-ups and evaluations that meetings generated, newest first: the person, the meeting, the due date, the state, the owners, the outcome that completed it and whether real contact was recorded (completion and contact are separate facts).",
	input: obligationsInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const found = value(
			await followUpReader.readObligations(
				tx,
				actor.authority,
				readObligationsRequest.parse({ ...input, limit: input.limit ?? 50 }),
			),
		);
		return result(
			"followups.readObligations",
			found.items.map((o) => {
				const owners = owning(o.owners);
				return {
					kind: "follow_up" as const,
					id: o.task?.id ?? o.id,
					label: o.person?.label ?? `Evaluation of ${o.meeting.label}`,
					fields: {
						obligationId: o.id,
						kind: o.kind,
						personId: o.person?.id ?? null,
						meeting: o.meeting.label,
						meetingDate: o.origin.date,
						due: o.dueDate,
						state: o.state,
						owners: ownerNames(actor, owners),
						needsOwner: owners.length === 0,
						completedWith: o.completion?.outcome ?? null,
						completedAt: o.completion?.occurredAt ?? null,
						contacted: o.contacted,
						taskStatus: o.task?.status ?? null,
					},
				};
			}),
			["contact notes", "people's profile notes"],
			{ total: found.total, page: found.page, next: found.next },
		);
	},
};

const historyInput = z.strictObject({
	personId: z.uuid().describe("A person id from an earlier result"),
	taskId: z.uuid().optional().describe("Only the entries recorded on this follow-up"),
	...page,
});
export const listContactHistory: ReadAdapter<z.infer<typeof historyInput>> = {
	operation: "followups.listContactHistory",
	description:
		"Read one person's recorded contact log, newest first: each outcome a person recorded (contacted, attempted_no_contact, administrative_completion or no_longer_needed), when it happened, how and who recorded it. Only an effective contacted outcome is a conversation that happened. Sent emails are not in this log, and no entry is not proof that nobody reached out.",
	input: historyInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const reply = await followUpReader.listContactHistory(
			tx,
			actor.authority,
			listContactHistoryRequest.parse({ ...input, limit: input.limit ?? 50 }),
		);
		// A foreign, retired-elsewhere or guessed person reads the same as one with no log.
		if (reply.status !== "ok") return result("followups.listContactHistory", [], []);
		const log = reply.value;
		return result(
			"followups.listContactHistory",
			log.items.map((o) => ({
				kind: "contact" as const,
				id: o.id,
				label: o.outcome,
				fields: {
					personId: o.personId,
					outcome: o.outcome,
					conversationHappened: o.contact,
					occurredAt: o.occurredAt,
					channel: o.channel,
					recordedBy:
						o.actor.kind === "account"
							? o.actor.accountId === actor.accountId
								? "you"
								: o.actor.displayName
							: "a former member",
					state: o.state,
					completedFollowUp: o.completedTask,
					lastConfirmedContactAt: log.lastConfirmedContactAt,
				},
			})),
			["contact notes", "sent emails (not readable here yet)"],
			{ total: log.total, page: log.page, next: log.next },
		);
	},
};

/** The installed Follow-up read tools, in catalog order. */
export const FOLLOWUP_READS = [
	listFollowUpOwners,
	readObligations,
	listContactHistory,
	followUpCoverage,
	planHandoff,
] as const;
