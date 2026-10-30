// WP-036/api: agendas generated from the meeting (REQ-DOC-007). No database: it renders real bytes from meeting facts.
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { PDFDocument } from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import {
	ATTENDEE_CAP,
	addMinutes,
	agendaKindOf,
	agendaMeetingOf,
	durationText,
	type MeetingRead,
} from "../../../packages/domain/src/documents/agenda-meeting.ts";
import { library } from "../../../packages/domain/src/documents/catalog.ts";
import { resolveMerge } from "../../../packages/domain/src/documents/merge.ts";
import { renderTemplatePdf } from "../../../packages/domain/src/documents/render.ts";
import { NEUTRAL_THEME } from "../../../packages/domain/src/documents/theme.ts";
import { entryFor } from "../../../packages/domain/src/documents/templates/registry.ts";
import { sampleKit } from "./fixtures/sample-kit.ts";

const CHURCH = "Harborlight Church";
const IDS = ["vision-meeting-agenda", "board-meeting-agenda"] as const;
const OLD_TEXT = [
	"Welcome and prayer",
	"Our story",
	"The vision",
	"The ask: GROW, PRAY, GIVE",
	"Next steps",
	"Opening prayer",
	"Approve the minutes",
	"Financial report",
	"Ministry updates",
	"Action items",
	"Greet every guest by name",
	"Read back each action",
];

const meetingOf = (over: Partial<MeetingRead> = {}): MeetingRead => ({
	type: "vision_meeting",
	title: null,
	visionNumber: 12,
	localDate: "2026-11-10",
	localTime: "18:30",
	venueName: "Harbor Hall",
	venueAddress: "12 Dock Street",
	agenda: [
		{ title: "Greeting", minutes: 10 },
		{ title: "Story", minutes: 25 },
		{ title: "Prayer", minutes: 5 },
	],
	leadership: false,
	attendees: [
		{ name: "Ada Brown", role: null },
		{ name: "Ben Cole", role: null },
	],
	attendeeTotal: 2,
	...over,
});
const lines = (r: { text: string[][] }) => r.text.flat();
const render = (id: string, m?: MeetingRead, theme?: Parameters<typeof renderTemplatePdf>[2]) =>
	renderTemplatePdf(
		{ id },
		{ church_name: CHURCH, ...(id === "vision-meeting-agenda" ? { pastor_name: "Pastor Ada" } : {}) },
		theme,
		m ? agendaMeetingOf(m, 2026) : undefined,
	);
const names = (r: { fields: { name: string }[] }) => r.fields.map((f) => f.name);
const countOf = (r: { fields: { name: string }[] }, prefix: string) =>
	r.fields.filter((f) => f.name.startsWith(prefix)).length;

describe("WP-036/api agendas from the meeting", () => {
	test("text rules match the meeting screen: title, date, time, start times, total, kind", () => {
		const a = agendaMeetingOf(meetingOf(), 2026);
		assert.equal(a.title, "Vision Meeting #12");
		assert.equal(a.date, "Tue Nov 10");
		assert.equal(agendaMeetingOf(meetingOf(), 2027).date, "Tue Nov 10, 2026");
		assert.equal(a.time, "6:30 pm");
		assert.equal(a.place, "Harbor Hall, 12 Dock Street");
		assert.deepEqual(
			a.sections.map((s) => [s.title, s.minutes, s.start]),
			[
				["Greeting", 10, "6:30 pm"],
				["Story", 25, "6:40 pm"],
				["Prayer", 5, "7:05 pm"],
			],
		);
		assert.equal(a.totalMinutes, 40);
		assert.equal(durationText(80), "1 h 20 min");
		assert.equal(addMinutes("23:50", 20), "00:10");
		assert.equal(agendaMeetingOf(meetingOf({ title: "Fall kickoff" }), 2026).title, "Fall kickoff");
		assert.equal(agendaMeetingOf(meetingOf({ venueName: null, venueAddress: null }), 2026).place, null);
		assert.equal(agendaKindOf({ type: "vision_meeting", leadership: false }), "vision");
		assert.equal(agendaKindOf({ type: "team_meeting", leadership: true }), "board");
		for (const [type, leadership] of [
			["team_meeting", false],
			["orientation", true],
			["prelaunch_practice", false],
		] as const)
			assert.equal(agendaKindOf({ type, leadership }), null, type);
	});

	test("DOC-007: with no meeting both agendas are the blank sheet, with no invented segments", async () => {
		for (const id of IDS) {
			const r = await render(id);
			const text = lines(r).join(" ");
			for (const old of OLD_TEXT) assert.equal(text.includes(old), false, `${id}: ${old}`);
			assert.equal(r.pages, 1);
			const bare = await renderTemplatePdf({ id }, { church_name: CHURCH });
			assert.deepEqual(new Set(names(bare)), new Set(entryFor(id)!.fields), id);
			assert.equal(countOf(r, "time_"), 6);
			assert.equal(countOf(r, "segment_"), 6);
			assert.equal(countOf(r, "lead_"), 6);
			assert.equal(countOf(r, "notes_"), 6);
			assert.equal(countOf(r, "attendee_") / 2, 8);
			assert.equal(countOf(r, "present_"), 8);
			assert.ok(names(r).includes("meeting_date") && names(r).includes("meeting_place"));
			assert.ok(text.includes(CHURCH));
		}
		// The #375 facilitator rule: the pastor on the Vision agenda, a blank field on the board agenda.
		assert.ok(lines(await render("vision-meeting-agenda")).includes("Pastor Ada"));
		assert.equal(names(await render("vision-meeting-agenda")).includes("facilitator"), false);
		assert.ok(names(await render("board-meeting-agenda")).includes("facilitator"));
	});

	test("DOC-007: the header and the run of show print exactly what the meeting holds, in order", async () => {
		for (const id of IDS) {
			const r = await render(id, meetingOf());
			const all = lines(r);
			const text = all.join(" ");
			for (const s of ["Vision Meeting #12", "Tue Nov 10", "6:30 pm"]) assert.ok(all.includes(s), `${id}: ${s}`);
			assert.ok(text.includes("Harbor Hall, 12 Dock Street"), "place");
			assert.ok(all.includes("40 min"), "total");
			const order = ["Greeting", "Story", "Prayer"].map((t) => all.indexOf(t));
			assert.ok(order.every((i) => i >= 0) && order[0]! < order[1]! && order[1]! < order[2]!, `${id}: order`);
			assert.deepEqual(
				all.filter((l) => /^\d{1,2}:\d{2} (am|pm)$/.test(l)).slice(1, 4),
				["6:30 pm", "6:40 pm", "7:05 pm"],
			);
			assert.deepEqual(
				all.filter((l) => /^\d+ min$/.test(l)),
				["40 min", "10 min", "25 min", "5 min"],
			);
			for (const old of OLD_TEXT) assert.equal(text.includes(old), false, `${id}: ${old}`);
			assert.equal(countOf(r, "lead_"), 3);
			assert.equal(countOf(r, "notes_"), 3);
			assert.equal(countOf(r, "time_"), 0);
			assert.equal(countOf(r, "segment_"), 0);
			assert.equal(names(r).includes("meeting_place"), false);
			assert.equal(names(r).includes("meeting_time"), false);
		}
	});

	test("DOC-007: a meeting with no venue prints a blank Place field", async () => {
		const r = await render("vision-meeting-agenda", meetingOf({ venueName: null, venueAddress: null }));
		assert.ok(names(r).includes("meeting_place"));
		assert.equal(lines(r).join(" ").includes("Harbor Hall"), false);
	});

	test("DOC-007: attendees print sorted names, roles, empty Here boxes and blank rows up to the minimum", async () => {
		const r = await render("vision-meeting-agenda", meetingOf());
		const all = lines(r);
		assert.ok(all.indexOf("Ada Brown") >= 0 && all.indexOf("Ada Brown") < all.indexOf("Ben Cole"));
		// 2 people: the rest of the 8 rows are blank write-in rows; Role is a blank field off a leadership team.
		assert.equal(countOf(r, "present_"), 8);
		assert.equal(r.fields.filter((f) => f.name.startsWith("attendee_") && f.name.endsWith("_name")).length, 6);
		assert.equal(r.fields.filter((f) => f.name.endsWith("_role")).length, 8);
		const doc = await PDFDocument.load(r.bytes, { updateMetadata: false });
		for (const f of doc.getForm().getFields())
			if (f.getName().startsWith("present_")) assert.equal((f as never as { isChecked(): boolean }).isChecked(), false);
		const board = await render(
			"board-meeting-agenda",
			meetingOf({
				type: "team_meeting",
				leadership: true,
				title: "Leadership huddle",
				attendees: [
					{ name: "Ada Brown", role: "Senior pastor" },
					{ name: "Ben Cole", role: null },
				],
			}),
		);
		assert.ok(lines(board).includes("Senior pastor"));
		assert.ok(lines(board).includes("Leadership huddle"));
	});

	test("DOC-007: no sections and nobody listed prints 6 blank run rows and 8 blank attendee rows", async () => {
		const r = await render("board-meeting-agenda", meetingOf({ type: "team_meeting", leadership: true, visionNumber: null, agenda: [], attendees: [], attendeeTotal: 0 }));
		const all = lines(r);
		for (const s of ["Team Meeting", "Tue Nov 10", "6:30 pm"]) assert.ok(all.includes(s), s);
		assert.equal(countOf(r, "time_"), 6);
		assert.equal(countOf(r, "segment_"), 6);
		assert.equal(countOf(r, "present_"), 8);
		assert.equal(r.fields.filter((f) => f.name.endsWith("_name")).length, 8);
		assert.equal(all.some((l) => l.includes(" min")), false);
	});

	test("DOC-002, DOC-007: 40 sections and 100 people paginate with a footer on every page and stay in the limit", async () => {
		const m = meetingOf({
			agenda: Array.from({ length: 40 }, (_, i) => ({ title: `Section ${i + 1} ${"long ".repeat(i % 7)}`.trim(), minutes: 5 })),
			attendees: Array.from({ length: 100 }, (_, i) => ({ name: `Person ${String(i + 1).padStart(3, "0")}`, role: null })),
			attendeeTotal: 100,
		});
		const r = await render("vision-meeting-agenda", m);
		assert.ok(r.pages > 1);
		assert.ok(r.bytes.length < 8 * 1024 * 1024);
		r.text.forEach((page, i) => {
			assert.ok(page.some((l) => l.includes("Vision meeting agenda")), `footer text on page ${i + 1}`);
			assert.ok(page.some((l) => l.startsWith("Page ")), `page number on page ${i + 1}`);
		});
		const all = lines(r);
		for (let i = 1; i <= 40; i++) assert.ok(all.some((l) => l.startsWith(`Section ${i}`)), `Section ${i}`);
		for (const n of ["001", "050", "100"]) assert.ok(all.includes(`Person ${n}`), n);
		assert.equal(all.some((l) => l.includes("not shown")), false);
	});

	test("DOC-002: more people than the cap prints the cap and the count not shown", async () => {
		const total = ATTENDEE_CAP + 37;
		const m = meetingOf({
			attendees: Array.from({ length: ATTENDEE_CAP }, (_, i) => ({ name: `Person ${String(i + 1).padStart(3, "0")}`, role: null })),
			attendeeTotal: total,
		});
		const a = agendaMeetingOf(m, 2026);
		assert.equal(a.attendees.length, ATTENDEE_CAP);
		assert.equal(a.hiddenAttendees, 37);
		const r = await render("vision-meeting-agenda", m);
		assert.ok(lines(r).join(" ").includes(`This list shows the first ${ATTENDEE_CAP} people. 37 more are not shown.`));
		assert.ok(r.bytes.length < 8 * 1024 * 1024);
	});

	test("DOC-009: the same meeting renders under the neutral theme and a brand theme with the same facts", async () => {
		for (const id of IDS) {
			const neutral = await render(id, meetingOf(), NEUTRAL_THEME);
			const brand = await render(id, meetingOf(), sampleKit());
			assert.deepEqual(lines(neutral).filter((l) => /Greeting|Story|Prayer|Ada Brown/.test(l)), lines(brand).filter((l) => /Greeting|Story|Prayer|Ada Brown/.test(l)));
			assert.notDeepEqual(neutral.bytes, brand.bytes);
			assert.ok(brand.bytes.includes("Harborlight Church logo"));
			assert.deepEqual(new Set(names(neutral)), new Set(names(brand)));
		}
	});

	test("DOC-002: meeting_date resolves from the meeting; an explicit override wins", async () => {
		const { templates } = await library();
		const template = templates.find((t) => t.id === "vision-meeting-agenda")!;
		const sources = { churchName: CHURCH, pastorName: null, launchDate: null, meetingDate: "Tue Nov 10" };
		const auto = resolveMerge(template, sources, {});
		assert.ok(auto.ok);
		const field = auto.ok && auto.fields.find((f) => f.key === "meeting_date");
		assert.deepEqual([field && field.value, field && field.source], ["Tue Nov 10", "meeting"]);
		const over = resolveMerge(template, sources, { meeting_date: "Nov 11" });
		assert.ok(over.ok);
		const won = over.ok && over.fields.find((f) => f.key === "meeting_date");
		assert.deepEqual([won && won.value, won && won.source], ["Nov 11", "override"]);
		const none = resolveMerge(template, { ...sources, meetingDate: null }, {});
		assert.ok(none.ok && none.fields.find((f) => f.key === "meeting_date")?.source === "absent");
	});
});
