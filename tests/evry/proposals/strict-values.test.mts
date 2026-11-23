import test from "node:test";
import assert from "node:assert/strict";
import { eventRow, userMessageBody } from "../../../packages/evry/src/conversations/store.ts";
import { proposalRow } from "../../../packages/evry/src/proposals/review.ts";
import { savedRevision } from "../../../packages/evry/src/proposals/types.ts";

const ID = "4f0c2a1e-8d3b-4c5a-9e7f-1a2b3c4d5e6f";
const AT = "2026-11-20T10:00:00.000Z";

type Parsed = { success: boolean; error?: { issues: { code: string; path: PropertyKey[] }[] } };
const CASES: { name: string; schema: { safeParse(value: unknown): Parsed }; valid: Record<string, unknown> }[] = [
	{
		name: "saved proposal args",
		schema: savedRevision,
		valid: { expectedRevision: "3", input: { personId: ID, patch: { city: "Austin" } } },
	},
	{
		name: "conversation event row",
		schema: eventRow,
		valid: { sequence: "4", turnId: ID, kind: "user_message", body: { text: "Who is new?" }, createdAt: AT },
	},
	{
		name: "user message body",
		schema: userMessageBody,
		valid: { text: "Try again", references: [{ kind: "person", id: ID }], retryOf: 2 },
	},
	{
		name: "proposal receipt",
		schema: proposalRow.shape.receipt,
		valid: { receiptId: ID, revision: "5", people: [{ id: ID, label: "Ann Lee", outcome: "changed" }] },
	},
	{ name: "reached receipt", schema: proposalRow.shape.receipt, valid: { reached: true } },
];

test("INV-strict-values: a stored Evry value with a key its schema does not name is refused, and the value without it parses", () => {
	for (const c of CASES) {
		assert.equal(c.schema.safeParse(c.valid).success, true, `${c.name} parses`);
		const extra = c.schema.safeParse({ ...c.valid, unexpected: true });
		assert.equal(extra.success, false, `${c.name} refuses an extra key`);
		assert.deepEqual(
			extra.error?.issues.map((i) => [i.code, i.path]),
			[["unrecognized_keys", []]],
			c.name,
		);
	}
});
