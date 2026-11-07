// T-52 (Nora QA 2026-11-04, #437 criterion 5): the guest list's Email column (REQ-COM-010). Owners and Admins always
// see it, between RSVP and Attendance. A guest with no recorded open reads "No open recorded", which claims nothing about
// delivery. While no guest has an open, one note says when opens appear. Members see no column and no note, and an empty
// guest list keeps its own empty state.
//
// It renders the real GuestList in node, with no browser and no database. Next.js swaps every "use server" module for a
// network stub in the browser; this test does the same with node's module mocks, so the client component loads alone.
// It runs from packages/domain's test:unit: tsx --experimental-test-module-mocks --test <this file>.
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
for (const file of globSync("apps/web/src/**/*.ts", { cwd: root })) {
	const text = readFileSync(root + file, "utf8");
	if (!/^(\s*(\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*["']use server["']/.test(text)) continue;
	const names = [...text.matchAll(/^export (?:async function|function|const) (\w+)/gm)].map((m) => m[1]!);
	const stub = async () => {
		throw new Error("No server action runs in this test.");
	};
	mock.module(pathToFileURL(root + file).href, { namedExports: Object.fromEntries(names.map((n) => [n, stub])) });
}

const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
// Guest names link through the app router; a router that goes nowhere stands in for the mounted one.
const { AppRouterContext } = web("next/dist/shared/lib/app-router-context.shared-runtime");
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const { ToastProvider } = await import("../../../packages/ui/src/controls/index.ts");
const { GuestList } = await import("../../../apps/web/src/features/meetings/GuestList.tsx");

const ZONE = "America/Chicago";
const meeting = {
	id: "00000000-0000-4000-8000-000000000001",
	revision: 1,
	type: "team_meeting",
	status: "planning",
	displayTitle: "QA orientation",
	title: "QA orientation",
	startsAt: "2026-11-12T00:30:00.000Z",
	localDate: "2026-11-11",
	localTime: "18:30",
	zone: ZONE,
	visionNumber: null,
	venue: null,
	guestCount: 2,
	confirmedCount: 0,
	preparation: "not_applicable",
	notes: null,
	kit: null,
	occurrence: { heldAt: null, voidedAt: null },
	retiredAt: null,
};
const SARA = "00000000-0000-4000-8000-0000000000a1";
const LEO = "00000000-0000-4000-8000-0000000000a2";
const guest = (n: number, personId: string, displayName: string) => ({
	id: `00000000-0000-4000-8000-00000000000${n}`,
	revision: 1,
	person: { personId, displayName, state: "live" },
	inviter: null,
	rsvp: "pending",
	rsvpSource: null,
	rsvpAt: null,
	presence: "unmarked",
	hasCard: false,
});
const GUESTS = [guest(1, SARA, "Sara Nunez"), guest(2, LEO, "Leo Pratt")];
const presence = {
	set() {},
	lanes: { unknown: [], stateOf: () => undefined, busy: false },
	stateOf: () => undefined,
	shown: <G,>(list: G[]) => list,
	busy: false,
};
const NOTE = "Email opens show here after a message from this meeting is sent and opened.";

/** The guest list as a viewer reads it: its column headers, the text of each body row and the text outside the table. */
function render({
	canWrite,
	guests = GUESTS,
	emailOpens = [],
}: {
	canWrite: boolean;
	guests?: unknown[];
	emailOpens?: { personId: string; openedAt: string }[];
}) {
	const markup: string = renderToStaticMarkup(
		createElement(
			AppRouterContext.Provider,
			{ value: router },
			createElement(
				ToastProvider,
				null,
				createElement(GuestList, {
					meeting,
					guests,
					emailOpens,
					cards: null,
					attendance: null,
					presence,
					canMark: canWrite,
					canWrite,
					project() {},
					onGuest() {},
					onRemoved() {},
					onCard() {},
					onStale() {},
				} as never),
			),
		),
	);
	const text = (html: string) =>
		html
			.replace(/<[^>]+>/g, " ")
			.replaceAll("&#x27;", "'")
			.replaceAll("&amp;", "&")
			.replace(/\s+/g, " ")
			.trim();
	const headers = [...markup.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]!));
	const rows = [
		...(markup.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g),
	].map((m) => text(m[1]!));
	return { headers, rows, all: text(markup) };
}

test("T-52: an Owner with guests and no open sees the Email column, No open recorded on each row and the note", () => {
	const { headers, rows, all } = render({ canWrite: true });
	const at = headers.indexOf("Email");
	assert.ok(at > 0, `an Email header: ${headers.join(" | ")}`);
	assert.equal(headers[at - 1], "RSVP");
	assert.equal(headers[at + 1], "Attendance");
	assert.equal(rows.length, 2);
	for (const row of rows) assert.match(row, /No open recorded/);
	assert.equal(all.split(NOTE).length - 1, 1, "the note shows once");
	// No open claims nothing about the email reaching the guest.
	assert.doesNotMatch(all, /not opened|not delivered|undelivered|failed|bounced/i);
});

test("T-52: one open shows Email opened at the meeting's time on that row, No open recorded on the other and no note", () => {
	const openedAt = "2026-11-05T15:04:00.000Z";
	const { rows, all } = render({ canWrite: true, emailOpens: [{ personId: SARA, openedAt }] });
	const sara = rows.find((r) => r.includes("Sara Nunez"))!;
	const leo = rows.find((r) => r.includes("Leo Pratt"))!;
	const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: ZONE }).format(
		new Date(openedAt),
	);
	assert.match(sara, /Email opened/);
	assert.ok(sara.includes(when), `the open time on the meeting's clock (${when}): ${sara}`);
	assert.doesNotMatch(sara, /No open recorded/);
	assert.match(leo, /No open recorded/);
	assert.doesNotMatch(leo, /Email opened/);
	assert.ok(!all.includes(NOTE), "the note is gone once a guest has an open");
});

test("T-52: a Member, or a team leader who is not Owner or Admin, sees no Email column and no note", () => {
	const { headers, all } = render({ canWrite: false });
	assert.deepEqual(headers, ["Guest", "Invited by", "RSVP", "Attendance"]);
	assert.ok(!all.includes("No open recorded"));
	assert.ok(!all.includes("Email opened"));
	assert.ok(!all.includes(NOTE));
});

test("T-52: an Owner's guest list with no guests keeps No guests yet and shows no note", () => {
	const { all } = render({ canWrite: true, guests: [] });
	assert.match(all, /No guests yet/);
	assert.ok(!all.includes(NOTE));
});
