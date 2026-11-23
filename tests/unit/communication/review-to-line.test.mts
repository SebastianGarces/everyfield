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

const summary = (recipients: (typeof ana)[], children: (typeof ana)[]): AudienceSummary => ({
	resolvedDistinctPeople: recipients.length + children.length,
	eligibleRecipients: recipients.length,
	missingEmailExclusions: [],
	duplicateAddressesRemoved: 0,
	recipients,
	complete: true,
	unsubscribedExclusions: [],
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
