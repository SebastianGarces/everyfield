import { organizationNotesResult, pipelineAccessResult, type PipelineAccessResult } from "@everyfield/contracts/access";
import type { ReadNotes } from "../port";

// Invented sample data for /design/access. Every reply goes through the contract parser, so a fixture that the
// real API could not return fails here first (WP-006/ui R8).

export const ACCESS_FLOWS = ["not-available", "session-ended", "pending", "staff-notes"] as const;
export type AccessFlow = (typeof ACCESS_FLOWS)[number];

export const VIEWERS = ["admin", "staff", "director", "admin-and-director"] as const;
export type Viewer = (typeof VIEWERS)[number];
export const VIEWER_LABEL: Record<Viewer, string> = {
	admin: "Administrator",
	staff: "Responsible staff",
	director: "Program director",
	"admin-and-director": "Admin and director",
};

export const NOTE_SCENARIOS = ["pages", "empty", "load-failed", "more-failed", "access-ended"] as const;
export type NoteScenario = (typeof NOTE_SCENARIOS)[number];
export const SCENARIO_LABEL: Record<NoteScenario, string> = {
	pages: "Several pages",
	empty: "No notes",
	"load-failed": "Load fails once",
	"more-failed": "Next page fails once",
	"access-ended": "Access ends",
};

export const PERSON = { id: "7d1e5c0a-3b9f-4f61-9a3e-1c2b4d5e6f70", name: "Jordan Ellis" };
export const ZONE = "America/Chicago";
const ORGANIZATION = {
	kind: "organization",
	id: "2a4c6e80-1b3d-4f5a-8c7e-9d0f1a2b3c4d",
	organizationKind: "sending_network",
} as const;

const AUTHORS: Record<string, string> = {
	"0f9e8d7c-6b5a-4c3d-8e1f-0a1b2c3d4e5f": "Priya Natarajan",
	"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d": "Marcus Hale",
};
export const authorName = (accountId: string) => AUTHORS[accountId] ?? "Staff account";

const DUTIES = {
	admin: [{ kind: "organization_administration", canReadStaffNotes: true }],
	staff: [{ kind: "responsible_staff", canReadStaffNotes: true }],
	director: [{ kind: "program_director", canReadStaffNotes: false }],
	"admin-and-director": [
		{ kind: "organization_administration", canReadStaffNotes: true },
		{ kind: "program_director", canReadStaffNotes: false },
	],
} as const;

export function accessFor(viewer: Viewer): PipelineAccessResult {
	return pipelineAccessResult.parse({
		status: "allowed",
		organization: ORGANIZATION,
		personId: PERSON.id,
		duties: DUTIES[viewer],
	});
}

const BODIES = [
	"First call after the assessment weekend. Jordan is clear about the city and less clear about timing. Asked for two more conversations with their spouse before a decision.",
	"Spouse joined this call. Both want a six-month residency with the Eastside church before launch planning.",
	"Coaching plan drafted:\n• weekly call on Tuesdays\n• read the Launch Playbook chapters 1 to 3\n• visit two church plants in the network",
	"Missed one call (family illness). Rescheduled, no concern.",
	"Long reflection from the residency check-in. Jordan named three worries: money for the first year, finding a worship leader, and the distance from family. We talked through each one. On money, the network fund covers part of year one and Jordan will ask two sending churches for the rest. On the worship leader, Marcus knows two people who may be interested and will make the introductions this month. On family, Jordan wants to keep one weekend a month free and asked us to hold them to it. I said we would put it on the coaching plan. Overall Jordan sounded steadier than in the first call and more ready to plan.",
	"Introductions to both worship leaders made. One meeting set for next week.",
	"Residency start date agreed with the Eastside church.",
	"Budget draft received. Needs a second look at rent.",
	"Rent reviewed with the treasurer. The draft is realistic.",
	"Second assessment step done. Notes from the panel are in the assessment record, not here.",
];

const NOTE_IDS = BODIES.map((_, i) => `c0ffee00-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);

function note(i: number) {
	const author = i === 3 ? { kind: "removed" } : { kind: "account", accountId: Object.keys(AUTHORS)[i % 2] };
	const day = String(2 + i * 3).padStart(2, "0");
	return {
		id: NOTE_IDS[i],
		author,
		body: BODIES[i],
		occurredAt: `2026-0${i < 5 ? 8 : 9}-${day}T15:${String(10 + i).padStart(2, "0")}:00Z`,
		revision: "1",
	};
}

const PAGE = 4;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fixture orgPeople.readNotes. Pages hold four notes so paging shows; the real API returns up to 100. The viewer's
 * notes duty comes from the same duties the page shows.
 */
export function notesReader(viewer: Viewer, scenario: NoteScenario, wait: number): ReadNotes {
	const duty = DUTIES[viewer].find((d) => d.canReadStaffNotes)?.kind;
	// "load-failed" fails every first-page read made while the panel mounts (React's development double mount
	// included), so Try again succeeds. "more-failed" fails the first next-page read once.
	const mounted = Date.now();
	let moreFailures = scenario === "more-failed" ? 1 : 0;
	return async (after) => {
		await delay(wait);
		const start = after ? NOTE_IDS.indexOf(after) + 1 : 0;
		if (!duty || (scenario === "access-ended" && start > 0))
			return organizationNotesResult.parse({ status: "unavailable" });
		if (scenario === "load-failed" && start === 0 && Date.now() - mounted < 1000 + wait) throw new Error("network");
		if (moreFailures > 0 && start > 0) {
			moreFailures -= 1;
			throw new Error("network");
		}
		const all = scenario === "empty" ? [] : BODIES.map((_, i) => note(i));
		const notes = all.slice(start, start + PAGE);
		const more = start + PAGE < all.length;
		return organizationNotesResult.parse({
			status: "allowed",
			purpose: "native_org_person_notes",
			organization: ORGANIZATION,
			personId: PERSON.id,
			duty,
			notes,
			next: more ? notes.at(-1)!.id : null,
		});
	};
}
