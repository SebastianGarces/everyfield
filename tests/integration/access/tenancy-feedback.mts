// The feedback reads of INV-tenancy (tenancy.test.mts): church A's owner sends feedback with marked words and page, and
// church B's owner asks for it by id, lists their own and tries the triage reads with no triage grant.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { authorizeTriage, feedbackWriter } from "../../../packages/domain/src/feedback/index.ts";

let sent;
export async function seedFeedback(t) {
	const reply = await feedbackWriter.submit(
		t.f.db,
		t.ownerA.actor,
		{ requestKey: randomUUID(), category: "bug", description: `${t.MARK} feedback words`, page: `${t.MARK} page` },
		{ appVersion: null },
	);
	sent = t.ok(reply).id;
}

export function feedbackCases(t, who) {
	const name = (op) => `feedback:feedbackWriter.${op}`;
	return [
		[
			name("getSendContext"),
			{
				// It takes no ids: the caller's own church, role and address.
				run: () => feedbackWriter.getSendContext(t.f.db, who.actor),
				expected: {
					check: (value) => assert.equal(value.replyTo, who.email),
					control: (value) => assert.equal(value.church, `${t.MARK} Church`),
				},
			},
		],
		[
			name("listOwn"),
			{
				run: () => feedbackWriter.listOwn(t.f.db, who.actor, {}),
				expected: { value: { items: [], next: null }, control: (value) => assert.equal(value.items[0].id, sent) },
			},
		],
		[
			name("getOwnStatus"),
			{
				run: () => feedbackWriter.getOwnStatus(t.f.db, who.actor, { feedbackId: sent }),
				expected: { refused: "unavailable", control: (value) => assert.equal(value.id, sent) },
			},
		],
		// No church owner holds a triage grant, so church A's owner is refused too: there is no control.
		[
			name("admin.list"),
			{
				run: () => feedbackWriter["admin.list"](t.f.db, who.actor, {}),
				expected: { refused: "access_denied", control: null },
			},
		],
		[
			name("admin.get"),
			{
				run: () => feedbackWriter["admin.get"](t.f.db, who.actor, { feedbackId: sent }),
				expected: { refused: "access_denied", control: null },
			},
		],
		[
			"feedback:authorizeTriage",
			{
				run: async () => ({ status: "ok", value: await authorizeTriage(t.f.db, who.actor) }),
				expected: { value: false, control: null },
			},
		],
	];
}
