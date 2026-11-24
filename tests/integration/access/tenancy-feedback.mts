import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { authorizeTriage, feedbackWriter } from "../../../packages/domain/src/feedback/index.ts";
import { tenancyCase, type Tenancy, type TenancyOwner } from "./tenancy-case.mts";

let sent: string;
export async function seedFeedback(t: Tenancy) {
	const reply = await feedbackWriter.submit(
		t.f.db,
		t.ownerA.actor,
		{ requestKey: randomUUID(), category: "bug", description: `${t.MARK} feedback words`, page: `${t.MARK} page` },
		{ appVersion: null },
	);
	sent = t.ok(reply).id;
}

export function feedbackCases(t: Tenancy, who: TenancyOwner) {
	const name = (op: string) => `feedback:feedbackWriter.${op}`;
	return [
		tenancyCase(name("getSendContext"), () => feedbackWriter.getSendContext(t.f.db, who.actor), {
			check: (value) => assert.equal(value.replyTo, who.email),
			control: (value) => assert.equal(value.church, `${t.MARK} Church`),
		}),
		tenancyCase(name("listOwn"), () => feedbackWriter.listOwn(t.f.db, who.actor, {}), {
			value: { items: [], next: null },
			control: (value) => assert.equal(value.items[0]!.id, sent),
		}),
		tenancyCase(name("getOwnStatus"), () => feedbackWriter.getOwnStatus(t.f.db, who.actor, { feedbackId: sent }), {
			refused: "unavailable",
			control: (value) => assert.equal(value.id, sent),
		}),
		tenancyCase(name("admin.list"), () => feedbackWriter["admin.list"](t.f.db, who.actor, {}), {
			refused: "access_denied",
			control: null,
		}),
		tenancyCase(name("admin.get"), () => feedbackWriter["admin.get"](t.f.db, who.actor, { feedbackId: sent }), {
			refused: "access_denied",
			control: null,
		}),
		tenancyCase(
			"feedback:authorizeTriage",
			async () => ({ status: "ok", value: await authorizeTriage(t.f.db, who.actor) }),
			{ value: false, control: null },
		),
	];
}
