import test from "node:test";
import assert from "node:assert/strict";
import { systemTemplates } from "../../../packages/contracts/src/communication/catalog.ts";
import { plainText, renderBody, sanitizeHtml } from "../../../packages/contracts/src/communication/html.ts";
import { templateDraft } from "../../../packages/contracts/src/communication/values.ts";

const rsvpKeys = new Set([
	"vision-meeting-invitation",
	"vision-meeting-reminder",
	"orientation-invitation",
	"team-meeting-invitation",
]);

// Identity of the seven system templates. Copy may change; these may not.
const pinned = [
	["vision-meeting-invitation", "Vision meeting invitation", "meeting_invitation", "vision_meeting"],
	["vision-meeting-reminder", "Vision meeting reminder", "meeting_reminder", null],
	["vision-meeting-follow-up-attended", "Vision meeting follow-up", "follow_up", null],
	["vision-meeting-follow-up-no-show", "Vision meeting follow-up for a missed guest", "follow_up", null],
	["orientation-invitation", "Orientation invitation", "meeting_invitation", "orientation"],
	["team-meeting-invitation", "Team meeting invitation", "meeting_invitation", "team_meeting"],
	["general-announcement", "General announcement", "announcement", null],
];

test("the seven system templates keep their keys, names, categories, meeting types and order", () => {
	assert.deepEqual(
		systemTemplates.map((t) => [t.sourceKey, t.name, t.category, t.meetingType]),
		pinned,
	);
});

for (const template of systemTemplates) {
	test(`system template ${template.sourceKey} is a complete, sendable email`, () => {
		const { sourceKey: _sourceKey, ...draft } = template;
		assert.doesNotThrow(() => templateDraft.parse(draft), "the contract parser accepts it, as a fork does");
		assert.equal(sanitizeHtml(template.bodyHtml), template.bodyHtml, "body survives the sanitizer unchanged");
		assert.ok(template.bodyHtml.startsWith("<p>Hello {{name}},</p>"));
		assert.ok(template.bodyHtml.endsWith("[Your name]</p>"));
		assert.ok(!template.subject.includes("{{"), "subjects are never merged");
		assert.ok(template.description, "has a description");
		assert.equal(template.description.split(/[.!?](?:\s|$)/).filter(Boolean).length, 1, "description is one sentence");
		assert.ok(template.description.endsWith("."));
		const fields = [...template.bodyHtml.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1]);
		const hasRsvp = rsvpKeys.has(template.sourceKey);
		assert.deepEqual([...new Set(fields)], hasRsvp ? ["name", "rsvp_link"] : ["name"], "only name and rsvp_link");
		assert.equal(
			template.bodyHtml.split("rsvp_link").length - 1,
			hasRsvp ? 1 : 0,
			"rsvp_link appears once or not at all",
		);
		if (hasRsvp) {
			assert.ok(template.bodyHtml.includes("<p>{{rsvp_link}}</p>"));
			assert.ok(
				template.bodyHtml.indexOf("<strong>Where:</strong>") < template.bodyHtml.indexOf("<p>{{rsvp_link}}</p>"),
				"the RSVP link follows the When/Where paragraph",
			);
		}
		const text = plainText(renderBody(template.bodyHtml, { name: "Alex" }));
		const outsideBrackets = text.replace(/\[[^\]]*\]/g, "");
		assert.ok(
			!/\bthe link\b|\bthe button\b|\bbelow\b|\bclick/i.test(outsideBrackets),
			"reads correctly without the RSVP link",
		);
		for (const sentence of text.split(/(?<=[.!?])\s+/)) {
			if (/repl(y|ies|ied|ying)\b/i.test(sentence)) {
				assert.ok(
					!/confirm|attend|\bcome\b|\bcoming\b|cannot|plans change|\bseat\b|rsvp/i.test(sentence),
					`no reply-as-RSVP sentence: ${sentence}`,
				);
			}
		}
	});
}

test("each meeting template renders exactly one RSVP button with a valid link, and none without one", () => {
	const href = "https://app.example.test/rsvp/tok_123";
	for (const template of systemTemplates) {
		const withLink = renderBody(template.bodyHtml, { name: "Alex", rsvp_link: href });
		const buttons = withLink.split("Tell us if you can come</a>").length - 1;
		assert.equal(buttons, rsvpKeys.has(template.sourceKey) ? 1 : 0, `${template.sourceKey}: one button or none`);
		if (buttons)
			assert.equal(withLink.split(`href="${href}"`).length - 1, 2, "the button links to the guest's RSVP page");
		assert.ok(!renderBody(template.bodyHtml, { name: "Alex" }).includes("data-rsvp-button"), "no link, no button");
	}
});
