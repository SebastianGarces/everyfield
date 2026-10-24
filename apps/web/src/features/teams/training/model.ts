import type * as c from "@everyfield/contracts/teams";
import type { z } from "zod";

// Words and shapes for the training screens. No React and no server code. A program belongs to one ministry, or to
// every ministry when teamId is null. Completion is a record a person makes. Scheduling a session does not create one.

export type Program = z.infer<typeof c.trainingList>["programs"][number];
export type Credit = z.infer<typeof c.trainingHistory>["credits"][number];
export type PersonTraining = z.infer<typeof c.personTraining>;
export type ProgramBody = z.infer<typeof c.trainingProgram>;
export type CreditBody = z.infer<typeof c.creditResult>;
export type RosterBody = z.infer<typeof c.rosterResult>;

export type Outcome<T> = { status: "ok"; value: T } | { status: "refused"; code: string } | { status: "lost" };

/** A program as the list shows it. `countsKnown` is false after the required list changes, until the list loads again. `rosterKnown` is false when that list did not load. */
export type ShownProgram = Program & { assignedIds: string[]; countsKnown: boolean; rosterKnown: boolean };

export type TrainingLoad = {
	programs: Program[];
	/** Null when the assignment read failed. The finished counts on each program still come from the list. */
	assigned: { id: string; personIds: string[] }[] | null;
};

export type PersonLoad = {
	summary: Outcome<PersonTraining>;
	credits: Outcome<Credit[]>;
};

const blank = (s: string) => s.trim() === "";

export function problemText(code: string): string {
	switch (code) {
		case "conflict":
			return "Someone else changed this program. Close this and open it again so you see the latest version.";
		case "invalid_subject":
			return "That person cannot be recorded here. They may be retired, in another church, or not on this required list.";
		case "invalid_input":
			return "Some details are not valid. Check them and try again.";
		case "unavailable":
			return "This program is not available. It may be archived, or your seat may have changed. Reload the page.";
		case "access_denied":
			return "You cannot make this change. Only an Owner, an Admin, or this ministry's leader can.";
		case "busy":
			return "Another change is still saving. Try again when it ends.";
		default:
			return "You cannot make this change. Only an Owner, an Admin, or this ministry's leader can.";
	}
}

/** This ministry's programs, then programs for every ministry. Archived programs go last. */
export function orderPrograms(programs: readonly ShownProgram[], teamId: string): ShownProgram[] {
	const rank = (p: ShownProgram) => (p.archived ? 2 : p.teamId === teamId ? 0 : 1);
	return [...programs].sort(
		(a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
	);
}

export function toShown(load: TrainingLoad, teamId: string): ShownProgram[] {
	const known = load.assigned !== null;
	const assigned = new Map((load.assigned ?? []).map((row) => [row.id, row.personIds]));
	const shown = load.programs
		.filter((p) => p.teamId === teamId || p.teamId === null)
		.map((p) => ({ ...p, assignedIds: assigned.get(p.id) ?? [], countsKnown: true, rosterKnown: known }));
	return orderPrograms(shown, teamId);
}

export function canWriteProgram(
	program: Pick<Program, "teamId" | "archived">,
	teamId: string,
	canChange: boolean,
	admin: boolean,
): boolean {
	if (program.archived) return false;
	if (program.teamId === null) return admin;
	return program.teamId === teamId && canChange;
}

/** The sentence under a program. Missing assignments are never called 100% complete. */
export function progressText(program: Pick<ShownProgram, "required" | "requiredPeople" | "compatibleCredits" | "countsKnown">): string {
	if (!program.required) return "Optional. A recorded completion stays, and it is not part of the required count.";
	if (!program.countsKnown) return "The required list changed. Reload to see how many have finished.";
	if (program.requiredPeople === 0) return "No one is assigned. This is not complete.";
	const done = program.compatibleCredits;
	const total = program.requiredPeople;
	return `${done} of ${total} ${total === 1 ? "person has" : "people have"} finished.`;
}

export function applyCreate(programs: readonly ShownProgram[], program: ProgramBody, teamId: string): ShownProgram[] {
	if (program.teamId !== teamId && program.teamId !== null) return orderPrograms([...programs], teamId);
	if (programs.some((p) => p.id === program.id)) return orderPrograms([...programs], teamId);
	const row: ShownProgram = {
		...program,
		requiredPeople: 0,
		compatibleCredits: 0,
		assignedIds: [],
		countsKnown: true,
		rosterKnown: true,
	};
	return orderPrograms([...programs, row], teamId);
}

export function applyCorrect(programs: readonly ShownProgram[], result: { outcome: "changed" | "noop"; program: ProgramBody }, teamId: string): ShownProgram[] {
	if (result.outcome === "noop") return [...programs];
	return orderPrograms(
		programs.map((p) =>
			p.id === result.program.id
				? {
						...p,
						name: result.program.name,
						required: result.program.required,
						version: result.program.version,
						revision: result.program.revision,
						archived: result.program.archived,
						teamId: result.program.teamId,
						compatibleCredits: result.program.version === p.version ? p.compatibleCredits : 0,
						countsKnown: true,
					}
				: p,
		),
		teamId,
	);
}

export function applyRoster(
	programs: readonly ShownProgram[],
	result: { outcome: "changed" | "noop"; programId: string; personIds: string[] },
): ShownProgram[] {
	if (result.outcome === "noop") return [...programs];
	return programs.map((p) =>
		p.id === result.programId
			? {
					...p,
					assignedIds: result.personIds,
					requiredPeople: result.personIds.length,
					countsKnown: false,
					rosterKnown: true,
				}
			: p,
	);
}

/** A new compatible completion counts only for someone on the required list. A revoke removes one. */
export function applyCredit(programs: readonly ShownProgram[], result: CreditBody): ShownProgram[] {
	if (result.outcome !== "changed" || result.programId === null) return [...programs];
	return programs.map((p) => {
		if (p.id !== result.programId || !p.countsKnown || !p.assignedIds.includes(result.personId)) return p;
		if (result.kind === "revoked") return { ...p, compatibleCredits: Math.max(0, p.compatibleCredits - 1) };
		if (result.kind === "earned")
			return { ...p, compatibleCredits: Math.min(p.requiredPeople, p.compatibleCredits + 1) };
		return p;
	});
}

/** The latest credit for each program. History arrives oldest first, so the last row wins. */
export function latestByProgram(credits: readonly Credit[]): Map<string, Credit> {
	const map = new Map<string, Credit>();
	for (const credit of credits) if (credit.programId) map.set(credit.programId, credit);
	return map;
}

export function todayLocal(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

export const NAME_MAX = 200;
export const REASON_MAX = 500;

export function nameError(name: string): string | null {
	if (blank(name)) return "Enter a name.";
	if (name.trim().length > NAME_MAX) return "Use 200 characters or fewer.";
	return null;
}

export function reasonError(reason: string): string | null {
	if (blank(reason)) return "Enter a reason.";
	if (reason.trim().length > REASON_MAX) return "Use 500 characters or fewer.";
	return null;
}

export function dateError(day: string): string | null {
	return /^\d{4}-\d{2}-\d{2}$/.test(day) ? null : "Enter the day they finished.";
}

export function daysError(raw: string, label: string): string | null {
	if (!/^\d{1,5}$/.test(raw.trim())) return `Enter ${label} as a whole number.`;
	const n = Number(raw);
	if (n > 20000) return "Enter 20000 days or fewer.";
	return null;
}

export type CreateForm = { kind: "create"; name: string; required: boolean; churchwide: boolean; problem?: string };
export type CorrectForm = {
	kind: "correct";
	programId: string;
	revision: string;
	name: string;
	required: boolean;
	reason: string;
	problem?: string;
};
export type PersonForm = {
	kind: "complete" | "revoke" | "redo";
	programId: string;
	revision: string;
	programName: string;
	personId: string | null;
	personName: string;
	earnedOn: string;
	problem?: string;
};
export type AssignForm = {
	kind: "assign";
	programId: string;
	revision: string;
	programName: string;
	personIds: string[];
	problem?: string;
};
export type ServiceForm = {
	kind: "service";
	personId: string | null;
	personName: string;
	attendanceDays: string;
	volunteerDays: string;
	problem?: string;
};
export type Flow = CreateForm | CorrectForm | PersonForm | AssignForm | ServiceForm;

export const createForm = (): CreateForm => ({ kind: "create", name: "", required: true, churchwide: false });
export const correctForm = (program: ShownProgram): CorrectForm => ({
	kind: "correct",
	programId: program.id,
	revision: program.revision,
	name: program.name,
	required: program.required,
	reason: "",
});
export const personForm = (
	kind: PersonForm["kind"],
	program: Pick<ShownProgram, "id" | "revision" | "name">,
	person?: { id: string; name: string } | null,
): PersonForm => ({
	kind,
	programId: program.id,
	revision: program.revision,
	programName: program.name,
	personId: person?.id ?? null,
	personName: person?.name ?? "",
	earnedOn: todayLocal(),
});
export const assignForm = (program: ShownProgram): AssignForm => ({
	kind: "assign",
	programId: program.id,
	revision: program.revision,
	programName: program.name,
	personIds: program.assignedIds,
});
export const serviceForm = (person?: { id: string; name: string } | null): ServiceForm => ({
	kind: "service",
	personId: person?.id ?? null,
	personName: person?.name ?? "",
	attendanceDays: "",
	volunteerDays: "",
});
