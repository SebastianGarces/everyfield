import type * as C from "@everyfield/contracts/onboarding";
import type { z } from "zod";

export type Resume = Extract<z.infer<typeof C.resumeResult>, { status: "available" }>;
type DiscoveryProfile = Extract<z.infer<typeof C.discoveryProfileResult>, { status: "active" }>["profile"];
export type OnboardingError = z.infer<typeof C.onboardingError>;
export type ErrorCode = OnboardingError["code"];
export type Reply<T> = { status: "ok"; value: T } | { status: "refused"; error: OnboardingError };
export type JourneyAnswer = z.input<typeof C.journeyAnswer>;
export type LaunchAnswer = z.input<typeof C.launchAnswer>;
export type Relationship = DiscoveryProfile["relationships"][number];

export type Entry =
	| { kind: "confirm_email" }
	| { kind: "start"; offer: "planter" | "discovery" | "either"; accountRevision: string }
	| { kind: "plant"; plantName: string | null; resume: Resume }
	| { kind: "discovery"; profile: DiscoveryProfile }
	| { kind: "elsewhere"; reason: "member" | "organization" | "unavailable" };

export type StepKey = "church" | "journey" | "launch" | "team" | "finish";
export const STEPS: { key: Exclude<StepKey, "finish">; label: string }[] = [
	{ key: "church", label: "Your church" },
	{ key: "journey", label: "Where you are" },
	{ key: "launch", label: "Launch date" },
	{ key: "team", label: "Your team" },
];
const ORDER: StepKey[] = ["church", "journey", "launch", "team", "finish"];

export const PHASES = [
	{ phase: 0, name: "Discovery", detail: "Discerning the call, values and readiness" },
	{ phase: 1, name: "Core group development", detail: "Vision meetings, follow-up, building commitment" },
	{ phase: 2, name: "Launch team formation", detail: "Launch date set, leaders filling roles" },
	{ phase: 3, name: "Training and preparation", detail: "Training teams and testing systems" },
	{ phase: 4, name: "Pre-launch", detail: "Pre-launch services and promotion" },
	{ phase: 5, name: "Launch Sunday", detail: "The first public service" },
	{ phase: 6, name: "Post-launch", detail: "Building rhythms after launch" },
] as const;

export type JourneyDraft =
	{ answer: "existing"; phase: number } | { answer: "unsure" } | { answer: "discerning" } | { answer: "skip" };
export type LaunchDraft = { answer: "planned"; date: string } | { answer: "no_date" } | { answer: "skip" };
export type LeadDraft =
	{ answer: "yes"; roleName: string; teamName: string; seniorPastor: boolean } | { answer: "no" } | { answer: "skip" };
export type BasicsDraft = { name: string; city: string; stateProvince: string; country: string; confirmed: boolean };

export type Drafts = {
	basics: BasicsDraft;
	journey: JourneyDraft | null;
	launch: LaunchDraft | null;
	lead: LeadDraft | null;
	keep: string[];
};
const EMPTY_BASICS: BasicsDraft = { name: "", city: "", stateProvince: "", country: "", confirmed: false };
export const DEFAULT_LEAD = { roleName: "Lead pastor", teamName: "Leadership", seniorPastor: false } as const;
function emptyDrafts(): Drafts {
	return { basics: EMPTY_BASICS, journey: null, launch: null, lead: null, keep: [] };
}

export type Op = "createPlant" | "createDiscovery" | "convertDiscovery" | "declareJourney" | "answerLead" | "complete";
type Intent = { op: Op; digest: string; requestKey: string };
export type Command = { requestKey: string; expectedRevision: string; input: unknown };

export type Notice = { op: Op; code: ErrorCode; reloaded: boolean };

export type State = {
	entry: Entry;
	view: StepKey;
	drafts: Drafts;
	pending: Op | null;
	intent: Intent | null;
	notice: Notice | null;
};

export function initialState(entry: Entry, requested: StepKey | null, drafts = emptyDrafts()): State {
	const state: State = { entry, view: "church", drafts, pending: null, intent: null, notice: null };
	return { ...state, view: clampView(state, requested ?? (entry.kind === "plant" ? resumeStep(entry.resume) : null)) };
}

const journeySaved = (r: Resume) => r.journey.status === "saved";
export const journeyLocked = (r: Resume) => r.journey.status === "saved" && r.journey.value.answer === "existing";
export const leadLocked = (r: Resume) => r.lead.answer === "yes";
export function leadText(lead: Resume["lead"]): string {
	if (lead.answer === "yes")
		return lead.seniorPastor === "filled" ? "You hold the Senior pastor role" : "You hold the lead role";
	return lead.answer === "no" ? "Someone else leads" : lead.answer === "skip" ? "Skipped" : "Not answered";
}
export const skippedFill = (lead: Resume["lead"]) =>
	lead.answer === "yes" && lead.seniorPastor === "occupied"
		? "We did not fill the Senior pastor role. Someone in Leadership already holds it, and they keep it. You hold the lead role you entered instead."
		: null;
export const finished = (r: Resume) => r.completion.status === "completed";

export function stepDone(key: StepKey, r: Resume): boolean {
	switch (key) {
		case "church":
			return true;
		case "journey":
			return r.journey.status === "saved";
		case "launch":
			return r.launch.status === "saved";
		case "team":
			return r.lead.answer !== "pending";
		case "finish":
			return finished(r);
	}
}

function resumeStep(r: Resume): StepKey {
	if (finished(r)) return "finish";
	if (!stepDone("journey", r) || !stepDone("launch", r)) return "journey";
	if (!stepDone("team", r)) return "team";
	return "finish";
}

function clampView(state: Pick<State, "entry" | "drafts">, requested: StepKey | null): StepKey {
	if (state.entry.kind !== "plant") return "church";
	const r = state.entry.resume;
	const view = requested ?? resumeStep(r);
	if (view === "launch" && !journeySaved(r) && !state.drafts.journey) return "journey";
	return view;
}

export function addressStep(state: Pick<State, "entry" | "view">): StepKey | null {
	return state.entry.kind === "confirm_email" || state.entry.kind === "elsewhere" ? null : state.view;
}

export function nextStep(view: StepKey): StepKey {
	return ORDER[ORDER.indexOf(view) + 1] ?? view;
}
export function previousStep(view: StepKey): StepKey | null {
	return ORDER[ORDER.indexOf(view) - 1] ?? null;
}
export function parseStep(value: string | null | undefined): StepKey | null {
	return ORDER.includes(value as StepKey) ? (value as StepKey) : null;
}

export function shownJourney(state: State): JourneyDraft | null {
	if (state.drafts.journey) return state.drafts.journey;
	if (state.entry.kind !== "plant" || state.entry.resume.journey.status !== "saved") return null;
	return state.entry.resume.journey.value;
}
export function shownLaunch(state: State): LaunchDraft | null {
	if (state.drafts.launch) return state.drafts.launch;
	if (state.entry.kind !== "plant" || state.entry.resume.launch.status !== "saved") return null;
	const saved = state.entry.resume.launch.value;
	return saved.answer === "planned" ? { answer: "planned", date: saved.date } : saved;
}
export function shownLead(state: State): LeadDraft | null {
	if (state.drafts.lead) return state.drafts.lead;
	if (state.entry.kind !== "plant") return null;
	const lead = state.entry.resume.lead;
	return lead.answer === "no" || lead.answer === "skip" ? { answer: lead.answer } : null;
}

export function journeyInput(draft: JourneyDraft): JourneyAnswer {
	switch (draft.answer) {
		case "existing":
			return { answer: "existing", phase: draft.phase };
		case "unsure":
			return { answer: "unsure" };
		case "discerning":
			return { answer: "discerning" };
		case "skip":
			return { answer: "skip" };
	}
}
export function launchInput(draft: LaunchDraft, scheduleRevision: string): LaunchAnswer {
	if (draft.answer === "planned")
		return { answer: "planned", date: draft.date, expectedScheduleRevision: scheduleRevision };
	return draft.answer === "no_date" ? { answer: "no_date" } : { answer: "skip" };
}
const optional = (value: string) => (value.trim() ? value.trim() : null);
export function basicsInput(b: BasicsDraft) {
	const locality = { city: optional(b.city), stateProvince: optional(b.stateProvince), country: optional(b.country) };
	const any = locality.city || locality.stateProvince || locality.country;
	return { name: b.name.trim(), ...(any ? { locality } : {}), confirmed: true as const };
}
export function leadInput(draft: LeadDraft) {
	if (draft.answer !== "yes") return { answer: draft.answer };
	return {
		answer: "yes" as const,
		assignment: {
			kind: "minimal_role" as const,
			roleName: draft.roleName.trim(),
			container: { kind: "minimal" as const, name: draft.teamName.trim() },
		},
		seniorPastor: draft.seniorPastor,
	};
}

export function basicsProblems(b: BasicsDraft): { name?: string; confirmed?: string } {
	return {
		...(b.name.trim() ? {} : { name: "Enter your church’s name." }),
		...(b.name.trim().length > 200 ? { name: "Use 200 characters or fewer." } : {}),
		...(b.confirmed ? {} : { confirmed: "Confirm that you are setting up this church yourself." }),
	};
}
export function leadProblems(d: LeadDraft): { roleName?: string; teamName?: string } {
	if (d.answer !== "yes") return {};
	return {
		...(d.roleName.trim() ? {} : { roleName: "Enter a role name, like Lead pastor." }),
		...(d.teamName.trim() ? {} : { teamName: "Enter a team name, like Leadership." }),
	};
}

export function stable(value: unknown): string {
	if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
	if (value !== null && typeof value === "object")
		return (
			"{" +
			Object.keys(value)
				.sort()
				.map((k) => JSON.stringify(k) + ":" + stable((value as Record<string, unknown>)[k]))
				.join(",") +
			"}"
		);
	return JSON.stringify(value);
}

export type Hold = "busy" | "locked" | "unavailable";

function expectedRevision(entry: Entry, op: Op): string | null {
	if (op === "createPlant" || op === "createDiscovery") return entry.kind === "start" ? entry.accountRevision : null;
	if (op === "convertDiscovery") return entry.kind === "discovery" ? entry.profile.revision : null;
	return entry.kind === "plant" ? entry.resume.revision : null;
}

function locked(entry: Entry, op: Op): boolean {
	if (op === "createPlant") return entry.kind !== "start" || entry.offer === "discovery";
	if (op === "createDiscovery") return entry.kind !== "start" || entry.offer === "planter";
	if (op === "convertDiscovery") return entry.kind !== "discovery";
	if (entry.kind !== "plant") return true;
	if (op === "declareJourney") return journeyLocked(entry.resume);
	if (op === "answerLead") return leadLocked(entry.resume);
	return finished(entry.resume);
}

export function begin(
	state: State,
	op: Op,
	input: unknown,
	newKey: () => string,
): { state: State; send: Command } | { state: State; hold: Hold } {
	if (state.pending) return { state, hold: "busy" };
	if (locked(state.entry, op)) return { state, hold: "locked" };
	const revision = expectedRevision(state.entry, op);
	if (revision === null) return { state, hold: "unavailable" };
	const digest = stable({ op, input, revision });
	const intent =
		state.intent && state.intent.op === op && state.intent.digest === digest
			? state.intent
			: { op, digest, requestKey: newKey() };
	return {
		state: { ...state, pending: op, intent, notice: null },
		send: { requestKey: intent.requestKey, expectedRevision: revision, input },
	};
}

export type Results = {
	createPlant: z.infer<typeof C.createPlantResult>;
	createDiscovery: z.infer<typeof C.createDiscoveryResult>;
	convertDiscovery: z.infer<typeof C.convertDiscoveryResult>;
	declareJourney: z.infer<typeof C.journeyResult>;
	answerLead: z.infer<typeof C.leadAnswerResult>;
	complete: z.infer<typeof C.completeOnboardingResult>;
};
export type Settled = { [K in Op]: { op: K; reply: Reply<Results[K]> } }[Op];

const RELOAD_CODES: ReadonlySet<ErrorCode> = new Set([
	"conflict",
	"already_declared",
	"active_seat_conflict",
	"association_resolution_required",
	"unknown",
]);
export const needsReload = (s: Settled) =>
	s.reply.status === "refused"
		? RELOAD_CODES.has(s.reply.error.code)
		: s.op === "createPlant" || s.op === "convertDiscovery";

export function settle(state: State, s: Settled, fresh: Entry | null): State {
	if (state.pending !== s.op) return state;
	const base: State = { ...state, pending: null };
	if (s.reply.status === "refused") {
		const retry = s.reply.error.retry;
		const keep = retry === "same_request" || retry === "reconcile";
		const entry = fresh ?? state.entry;
		const notice = { op: s.op, code: s.reply.error.code, reloaded: fresh !== null };
		const next = { ...base, entry, intent: keep ? state.intent : null, notice };
		return { ...next, view: clampView(next, state.view) };
	}
	const done = { ...base, intent: null, notice: null };
	switch (s.op) {
		case "createPlant":
		case "convertDiscovery": {
			const entry = fresh ?? state.entry;
			const next = { ...done, entry, drafts: { ...done.drafts, basics: EMPTY_BASICS, keep: [] } };
			const isNew = s.reply.value.status === "created" || s.reply.value.status === "converted";
			return { ...next, view: clampView(next, isNew ? "church" : null) };
		}
		case "createDiscovery":
			return { ...done, entry: { kind: "discovery", profile: s.reply.value.profile } };
		case "declareJourney": {
			if (state.entry.kind !== "plant") return done;
			const v = s.reply.value;
			const resume: Resume = {
				...state.entry.resume,
				revision: v.revision,
				currentPhase: v.currentPhase,
				journey: v.journey,
				launch: v.launch,
				scheduledLaunchDate: v.scheduledLaunchDate,
				scheduleRevision: v.scheduleRevision,
			};
			const next = {
				...done,
				entry: { ...state.entry, resume },
				drafts: { ...done.drafts, journey: null, launch: null },
			};
			return { ...next, view: stepDone("team", resume) ? "finish" : "team" };
		}
		case "answerLead": {
			if (state.entry.kind !== "plant") return done;
			const v = s.reply.value;
			const resume: Resume = { ...state.entry.resume, revision: v.revision, lead: v.lead };
			return { ...done, entry: { ...state.entry, resume }, drafts: { ...done.drafts, lead: null }, view: "finish" };
		}
		case "complete": {
			if (state.entry.kind !== "plant") return done;
			const v = s.reply.value;
			const resume: Resume = { ...state.entry.resume, revision: v.revision, completion: v.completion };
			return { ...done, entry: { ...state.entry, resume }, view: "finish" };
		}
	}
}

export function reload(state: State, entry: Entry): State {
	const next = { ...state, entry };
	return { ...next, view: clampView(next, state.view) };
}

export function setView(state: State, view: StepKey): State {
	return { ...state, view: clampView(state, view), notice: null };
}
export function editDrafts(state: State, patch: Partial<Drafts>): State {
	return { ...state, drafts: { ...state.drafts, ...patch } };
}

export type Missing = { key: "journey" | "launch" | "lead" | "people" | "reading" | "values"; label: string };
export function missingFacts(r: Resume, articleCount: number): Missing[] {
	const out: Missing[] = [];
	if (r.journey.status !== "saved" || r.journey.value.answer !== "existing")
		out.push({ key: "journey", label: "Phase not declared. You are in the phase the church started in." });
	if (r.scheduledLaunchDate === null) out.push({ key: "launch", label: "No launch date yet." });
	if (r.lead.answer !== "yes") out.push({ key: "lead", label: "No lead role assigned." });
	if (r.peopleStep !== "saved") out.push({ key: "people", label: "No people added yet." });
	if (r.reading.status !== "complete")
		out.push({ key: "reading", label: `The ${articleCount} foundation articles are not all read yet.` });
	if (r.values === "missing") out.push({ key: "values", label: "Core values not written yet." });
	return out;
}
