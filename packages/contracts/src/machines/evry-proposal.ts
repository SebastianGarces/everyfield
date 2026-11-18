import { machine } from "./machine.ts";

export type ProposalSubject = {
	readonly now: boolean;
	readonly lapsed: boolean;
	readonly jobLive: boolean;
};

const revise = "evry.reviseProposal";
const approve = "evry.approveProposal";
const cancel = "evry.cancelProposal";
const retry = "evry.retryUnresolvedEffects";
const execute = "evry.executeProposal";

export const proposalMachine = machine({
	id: "evry-proposal",
	table: "proposal",
	column: "state",
	product: {
		column: "outcome",
		states: {
			pending: ["pending", null],
			approved: ["approved", null],
			approved_completed: ["approved", "completed"],
			approved_refused: ["approved", "refused"],
			approved_failed: ["approved", "failed"],
			cancelled: ["cancelled", null],
			expired: ["expired", null],
		},
	},
	states: ["pending", "approved", "approved_completed", "approved_refused", "approved_failed", "cancelled", "expired"],
	events: ["evry.prepareProposal", revise, approve, cancel, retry, execute],
	refusal: "review_closed",
	refusalCodes: [
		{ event: approve, from: "expired", code: "review_expired" },
		{ event: retry, from: "expired", code: "review_expired" },
		{ event: execute, from: "pending", code: "lost" },
		{ event: execute, code: "closed" },
	],
	initial: [{ event: "evry.prepareProposal", to: "pending" }],
	guards: {
		now: (s: ProposalSubject) => s.now,
		lapsed: (s: ProposalSubject) => s.lapsed,
		jobLive: (s: ProposalSubject) => s.jobLive,
	},
	facts: ["lapsed", "jobLive"],
	subjects: {
		queued: { now: false, lapsed: false, jobLive: false },
		now: { now: true, lapsed: false, jobLive: false },
	},
	edges: [
		{ event: revise, from: ["pending", "approved", "expired"], to: "pending" },
		{ event: approve, from: "pending", to: "approved" },
		{ event: approve, from: "approved", to: ["approved_completed", "approved_refused"], when: "now" },
		{ event: cancel, from: ["pending", "approved"], to: "cancelled" },
		{ event: retry, from: "approved", to: "approved", unless: ["now", "jobLive"] },
		{ event: retry, from: "approved_failed", to: "approved", unless: "now" },
		{ event: execute, from: "approved", to: ["approved_completed", "approved_refused"], unless: "now" },
		{ event: execute, from: "approved", to: "expired", when: "lapsed", unless: "now" },
	],
	stays: [
		{ event: approve, in: ["approved", "approved_completed", "approved_refused", "approved_failed"] },
		{ event: cancel, in: ["approved_completed", "approved_refused", "approved_failed", "cancelled", "expired"] },
		{ event: retry, in: ["approved_completed"] },
		{ event: retry, in: ["approved"], when: "jobLive", unless: "now" },
	],
	unchangedIsNoop: [],
	decided: [revise, approve, cancel, retry, execute],
	unwritten: ["approved_failed"],
	notes: [
		"Subject `now` is a write that runs at approval (`approveNow`); `queued` runs later as an `evry_effect` job.",
		"For `now`, one approval moves `pending` to `approved` and, in its next statement, to `approved_completed` or `approved_refused`. If that run throws, the row stays `approved`.",
		"A `pending` row whose `expires_at` has passed reads as expired but stays `pending`: only the effect job writes `expired`, from `approved`.",
		"A stay answers without writing: approve replays, cancel answers `cancelled: false`, retry answers `retried: false`.",
		"`executeProposal` is the effect job's step; its answers `closed` and `lost` leave the row unchanged.",
	],
	proof: "tests/evry/execution/proposal-machine.test.mts",
});
