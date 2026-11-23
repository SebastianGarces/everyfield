import assert from "node:assert/strict";
import { test } from "node:test";
import { blankForm, toLine, type Form } from "../../../apps/web/src/features/communication/composeModel.ts";
import type { AudienceSummary } from "../../../apps/web/src/features/communication/model.ts";

const ana = { id: "0b5c1e2a-1111-4a6b-8c7d-9e0f1a2b3c4d", displayName: "Ana Santos", email: "ana@example.test" };
const ben = { id: "0b5c1e2a-2222-4a6b-8c7d-9e0f1a2b3c4d", displayName: "Ben Santos", email: "ben@example.test" };
const lucia = { id: "0b5c1e2a-3333-4a6b-8c7d-9e0f1a2b3c4d", displayName: "Lucía Santos", email: "lucia@example.test" };

const form = (people: Form["people"], groups: string[] = [], teamIds: string[] = []): Form => {
	const base = blankForm();
	return {
		...base,
		people,
		audience: { ...base.audience, groups, teamIds, personIds: people.map((p) => p.id) } as Form["audience"],
	};
};

const summary = (
	recipients: (typeof ana)[],
	children: (typeof ana)[],
	{
		unsubscribed = [],
		missing = [],
		complete = true,
	}: { unsubscribed?: (typeof ana)[]; missing?: string[]; complete?: boolean } = {},
): AudienceSummary => ({
	resolvedDistinctPeople: recipients.length + children.length + unsubscribed.length + missing.length,
	eligibleRecipients: recipients.length,
	missingEmailExclusions: missing,
	duplicateAddressesRemoved: 0,
	recipients,
	complete,
	unsubscribedExclusions: unsubscribed.map(({ id, displayName }) => ({
		id,
		displayName,
		unsubscribedAt: "2026-11-01T00:00:00.000Z",
	})),
	childExclusions: children.map(({ id, displayName }) => ({ id, displayName })),
});

test("the review To line names picked people who get the email and leaves out those marked as a child", () => {
	assert.equal(toLine(form([ana, lucia, ben]), summary([ana, ben], [lucia]), []), "2 people · Ana Santos, Ben Santos");
});

test("the review To line names no one when every picked person is marked as a child", () => {
	assert.equal(toLine(form([lucia]), summary([], [lucia]), []), "0 people");
});

test("the review To line shows a group and team with only the count who get the email, adding no child", () => {
	const team = { id: "0b5c1e2a-4444-4a6b-8c7d-9e0f1a2b3c4d", name: "Welcome team" };
	assert.equal(
		toLine(form([], ["core_group"], [team.id]), summary([ana, ben], [lucia]), [team]),
		"2 people · Core group, Welcome team",
	);
});

test("the review To line leaves out picked people who are unsubscribed or have no email", () => {
	const una = { id: "0b5c1e2a-5555-4a6b-8c7d-9e0f1a2b3c4d", displayName: "Una Unsub", email: "una@example.test" };
	const ned = { id: "0b5c1e2a-6666-4a6b-8c7d-9e0f1a2b3c4d", displayName: "Ned Noemail", email: null };
	assert.equal(
		toLine(form([ana, una, ned]), summary([ana], [], { unsubscribed: [una], missing: [ned.displayName] }), []),
		"1 person · Ana Santos",
	);
});

test("the review To line keeps a picked person past the named-recipient cap", () => {
	assert.equal(
		toLine(form([ana, ben]), summary([ana], [], { complete: false }), []),
		"1 person · Ana Santos, Ben Santos",
	);
});
