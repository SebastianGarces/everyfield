import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cardView } from "../../../apps/web/src/features/evry/conversation/resultView.ts";
import { mount } from "./fake-dom.mts";

const { ResultCard } = await import("../../../apps/web/src/features/evry/conversation/ResultCard.tsx");

const ID = "11111111-1111-4111-8111-111111111111";
const PRIVATE = "PRIVATE please pray about the diagnosis";
const WORDS = Object.fromEntries(
	[
		"body",
		"bodyText",
		"bodyHtml",
		"text",
		"html",
		"content",
		"preview",
		"excerpt",
		"note",
		"notes",
		"noteText",
		"message",
		"messageBody",
		"description",
		"feedback",
		"words",
		"comment",
		"detail",
		"details",
		"summary",
	].map((field) => [field, PRIVATE]),
);
const row = (kind: string, label: string, fields: Record<string, unknown>) => ({
	kind,
	id: ID,
	label,
	fields: { ...WORDS, ...fields },
});
const at = "2026-11-03T12:00:00.000Z";
const CARDS: [string, ReturnType<typeof row>, string][] = [
	["people.getActivities", row("activity", "Note", { kind: "note", personId: ID, occurredAt: at }), "Note added"],
	[
		"people.getActivities",
		row("activity", "Note removed", { kind: "note_removed", personId: ID, occurredAt: at }),
		"Note removed",
	],
	["dashboard.activity", row("activity", "Added a note", { by: "Ana Lee", when: "Today" }), "Added a note"],
	["communication.list", row("message", "Friday note", { state: "draft", sendsAt: null }), "Draft"],
	[
		"communication.list",
		row("message", "Friday note", { state: "scheduled", sendsAtInstant: at, zone: "America/Chicago" }),
		"Friday note",
	],
	["communication.get", row("message", "Friday note", { results: "2 delivered", sentAt: "Mon" }), "2 delivered"],
	["communication.get", row("person", "Ana Lee", { result: "delivered", deliveredAt: at }), "Ana Lee"],
	["communication.forPerson", row("message", "Family night", { result: "delivered", sentAt: "Mon" }), "Family night"],
	["communication.forMeeting", row("message", "Family night", { state: "sent", sentAt: "Mon" }), "Family night"],
	["communication.resendCandidates", row("message", "Welcome", { tooSoon: false, sentAt: "Mon" }), "Welcome"],
	["communication.templates.list", row("template", "Welcome", { origin: "system" }), "Welcome"],
	[
		"feedback.listOwn",
		row("item", "Bug report", { sent: "Nov 3", status: "Received", href: "/settings" }),
		"Sent Nov 3",
	],
	["feedback.getOwnStatus", row("item", "Bug report", { sent: "Nov 3", status: "Received" }), "Sent Nov 3"],
];

test("INV-result-card-private: a note's text, a message's body and feedback words saved on a row never reach its card", async () => {
	for (const [operation, saved, line] of CARDS) {
		const result = {
			operation,
			status: "available" as const,
			rows: [saved],
			total: 1,
			page: 1,
			next: null,
			completeness: "complete" as const,
			exclusions: [],
		};
		const view = JSON.stringify(cardView(operation, result as never, null));
		assert.equal(view.includes(PRIVATE), false, `${operation}: ${view}`);
		const card = await mount(ResultCard, { operation, result, originalTotal: null, photos: {} });
		const shown = card.lines().join("\n");
		assert.equal(shown.includes(PRIVATE), false, `${operation}: ${shown}`);
		assert.ok(shown.includes(line), `${operation}: ${shown}`);
		await card.unmount();
	}
});
