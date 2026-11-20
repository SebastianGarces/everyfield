import assert from "node:assert/strict";
import { test } from "node:test";
import { mailReport } from "../../../packages/contracts/src/communication/results.ts";
import * as feedback from "../../../packages/contracts/src/feedback/index.ts";
import { evaluationFactors, recordEvaluationRequest } from "../../../packages/contracts/src/meetings/attendance.ts";
import { importValues } from "../../../packages/contracts/src/people/csv/index.ts";

type Value = Record<string, unknown>;
type Parsed = { success: boolean; error?: { issues: { code: string; path: PropertyKey[] }[] } };
type Case = {
	name: string;
	schema: { safeParse(value: unknown): Parsed };
	valid: Value;
	nested?: (string | number)[][];
};

const ID = "4f0c2a1e-8d3b-4c5a-9e7f-1a2b3c4d5e6f";
const AT = "2026-11-20T10:00:00.000000Z";
const own = { id: ID, category: "bug", submittedAt: AT, status: "new", publicUrl: null };
const triage = {
	id: ID,
	category: "suggestion",
	description: "Add a print view",
	status: "reviewed",
	revision: "2",
	submittedAt: AT,
	author: { name: "Ann Lee", email: "ann@example.test" },
	details: {
		page: "People",
		address: "/people",
		church: "Grace",
		role: "Owner",
		browser: "Firefox",
		screenWidth: 1440,
		screenHeight: 900,
		theme: "light",
		appVersion: "1.0.0",
	},
	reference: "FB-1",
	publication: { state: "pending", heldReason: null, url: null },
	operatorMail: null,
};
const change = { from: "new", to: "reviewed", by: "Ann Lee", at: AT };
const person = { name: "Ann Lee", outcome: "sent" };

const CASES: Case[] = [
	{
		name: "feedback submitFeedbackRequest",
		schema: feedback.submitFeedbackRequest,
		valid: { requestKey: ID, category: "bug", description: "The save button does nothing" },
	},
	{
		name: "feedback submittedFeedback",
		schema: feedback.submittedFeedback,
		valid: { id: ID, category: "bug", page: null, replyTo: "ann@example.test", submittedAt: AT },
	},
	{
		name: "feedback sendContext",
		schema: feedback.sendContext,
		valid: { church: "Grace", role: "Owner", replyTo: "ann@example.test" },
	},
	{ name: "feedback ownFeedback", schema: feedback.ownFeedback, valid: own },
	{
		name: "feedback ownFeedbackPage",
		schema: feedback.ownFeedbackPage,
		valid: { items: [own], next: null },
		nested: [["items", 0]],
	},
	{ name: "feedback listOwnRequest", schema: feedback.listOwnRequest, valid: { cursor: null } },
	{ name: "feedback getOwnStatusRequest", schema: feedback.getOwnStatusRequest, valid: { feedbackId: ID } },
	{
		name: "feedback triageFeedback",
		schema: feedback.triageFeedback,
		valid: triage,
		nested: [["author"], ["details"], ["publication"]],
	},
	{
		name: "feedback triagePage",
		schema: feedback.triagePage,
		valid: { items: [triage], next: null },
		nested: [
			["items", 0],
			["items", 0, "author"],
		],
	},
	{
		name: "feedback triageListRequest",
		schema: feedback.triageListRequest,
		valid: { status: "new", category: null, cursor: null },
	},
	{ name: "feedback triageGetRequest", schema: feedback.triageGetRequest, valid: { feedbackId: ID } },
	{ name: "feedback triageChange", schema: feedback.triageChange, valid: change },
	{
		name: "feedback triageDetail",
		schema: feedback.triageDetail,
		valid: { ...triage, history: [change] },
		nested: [["history", 0], ["details"]],
	},
	{
		name: "feedback changeStatusRequest",
		schema: feedback.changeStatusRequest,
		valid: { feedbackId: ID, expectedRevision: "1", status: "resolved" },
	},
	{
		name: "feedback statusChange",
		schema: feedback.statusChange,
		valid: { outcome: "changed", status: "resolved", revision: "2" },
	},
	{
		name: "people csv importValues",
		schema: importValues,
		valid: {
			displayName: "Ann Lee",
			firstName: "Ann",
			lastName: "Lee",
			email: "ann@example.test",
			phone: null,
			street: null,
			city: "Austin",
			stateProvince: "TX",
			postalCode: null,
			country: null,
			source: "other",
			sourceDetails: null,
			summaryNotes: null,
		},
	},
	{
		name: "meetings recordEvaluationRequest",
		schema: recordEvaluationRequest,
		valid: {
			requestKey: ID,
			input: { meetingId: ID, scores: Object.fromEntries(evaluationFactors.map((f) => [f, 4])), notes: null },
		},
		nested: [["input"], ["input", "scores"]],
	},
	{
		name: "communication mailReport schedule",
		schema: mailReport,
		valid: {
			kind: "schedule",
			confirmation: "confirmed",
			scheduledAt: AT,
			accepted: 2,
			refused: 0,
			unknown: 0,
			waiting: 2,
			leftOut: 1,
		},
	},
	{
		name: "communication mailReport reschedule",
		schema: mailReport,
		valid: { kind: "reschedule", confirmation: "confirmed", scheduledAt: AT, open: 0, sent: 3 },
	},
	{
		name: "communication mailReport cancel",
		schema: mailReport,
		valid: { kind: "cancel", confirmation: "not_confirmed", cancelled: 1, sent: 0, open: 1, people: [person] },
		nested: [["people", 0]],
	},
	{
		name: "communication mailReport replace",
		schema: mailReport,
		valid: { kind: "replace", confirmation: "not_confirmed", scheduledAt: AT, accepted: 0, refused: 0, unknown: 2 },
	},
	{
		name: "communication mailReport replace_stopped",
		schema: mailReport,
		valid: {
			kind: "replace_stopped",
			confirmation: "blocked",
			cancelled: 0,
			sent: 1,
			open: 0,
			people: [person],
			code: "provider_refused",
		},
		nested: [["people", 0]],
	},
];

function withExtra(value: Value, path: (string | number)[]): Value {
	const copy = structuredClone(value);
	let at: Record<string | number, unknown> = copy;
	for (const step of path) at = at[step] as Record<string | number, unknown>;
	at.unexpected = "extra";
	return copy;
}

for (const { name, schema, valid, nested = [] } of CASES)
	test(`INV-strict-contracts: ${name} parses its declared keys and refuses an unknown key at every object level`, () => {
		assert.equal(schema.safeParse(valid).success, true, `${name} refused its valid value`);
		for (const path of [[], ...nested]) {
			const found = schema.safeParse(withExtra(valid, path));
			assert.equal(found.success, false, `${name} accepted an unknown key at ${path.join(".") || "the top level"}`);
			assert.deepEqual(
				found.error?.issues.map((i) => [i.code, i.path]),
				[["unrecognized_keys", path]],
				name,
			);
		}
	});
