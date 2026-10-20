import * as C from "@everyfield/contracts/onboarding";
import { stable, type Command, type Entry, type ErrorCode, type Op } from "../model";
import { createPort, parseEntry, type OnboardingPort } from "../port";

// The design preview's API (WP-009/ui R8). It keeps the WP-009/api rules that the screens depend on: one creation
// per account, request-key replay, revision checks, a once-only existing-journey declaration, launch schedule
// revisions and a once-only completion stamp. Every reply is parsed by the contract here and again in port.ts.

export const PERSONAS = [
	"planter",
	"either",
	"discovery-new",
	"discovery",
	"created",
	"resume",
	"declared",
	"finished",
	"member",
	"organization",
	"email",
	"unavailable",
] as const;
export type Persona = (typeof PERSONAS)[number];
export const PERSONA_LABEL: Record<Persona, string> = {
	planter: "New planter (pending)",
	either: "Active account, no seat",
	"discovery-new": "New Discovery account",
	discovery: "Discovery with relationships",
	created: "Owner, church just created",
	resume: "Owner, part way",
	declared: "Owner, phase declared",
	finished: "Owner, finished",
	member: "Member of a church",
	organization: "Organization account",
	email: "Email not confirmed",
	unavailable: "Setup unavailable",
};
export const parsePersona = (v: string | null): Persona =>
	(PERSONAS as readonly string[]).includes(v ?? "") ? (v as Persona) : "planter";

const RETRY: Record<ErrorCode, "never" | "refresh" | "same_request" | "reconcile"> = {
	invalid_input: "never",
	access_denied: "never",
	unavailable: "never",
	invalid_subject: "never",
	conflict: "refresh",
	temporary: "same_request",
	unknown: "reconcile",
	active_seat_conflict: "refresh",
	association_resolution_required: "refresh",
	already_declared: "refresh",
	idempotency_conflict: "never",
};

export const DECLARATION_REASON = "Declared at setup — where this plant already was when it joined EveryField.";

const id = () => crypto.randomUUID();

const now = () => new Date().toISOString();
const ACCOUNT = "6f1c2a8e-3b7d-4c55-9a0e-1d2f3a4b5c6d";
const ORG_A = "3e9b1d24-6a5f-4c71-8b2e-9f0a1b2c3d4e";
const ORG_B = "8a7c6b5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d";
const ARTICLE_1 = "367a6c6b-7ec3-44e7-95fb-253097125e42";
const ARTICLE_2 = "eded80bd-e505-4a56-91d6-67b8d071ef73";
const OFF = {
	people: false,
	meetings: false,
	tasks: false,
	ministry_teams: false,
	wiki: false,
	activity: false,
	shared_findings: false,
};

type Raw = Record<string, unknown>;
type World = {
	persona: Persona;
	accountRevision: string;
	registration: "pending" | "active";
	offer: "planter" | "discovery" | "either" | null;
	plantName: string | null;
	resume: Raw | null;
	declared: boolean;
	scheduleRevision: string | null;
	discovery: Raw | null;
	replays: Map<string, { digest: string; value: unknown }>;
};

function freshResume(plantId: string): Raw {
	return {
		status: "available",
		basics: "created",
		plant: { kind: "plant", id: plantId },
		revision: "1",
		materialRevision: "1",
		currentPhase: 1,
		lead: { answer: "pending" },
		journey: { status: "pending" },
		launch: { status: "pending" },
		scheduledLaunchDate: null,
		peopleStep: "pending",
		completion: { status: "unfinished" },
		reading: { status: "incomplete" },
		values: "missing",
	};
}
function relationship(org: string, kind: "sending_church" | "sending_network", choices: Partial<typeof OFF>) {
	return {
		relationshipId: id(),
		organization: { kind: "organization", id: org, organizationKind: kind },
		revision: "2",
		consentRevision: "1",
		choices: { ...OFF, ...choices },
	};
}
function reading(articleId: string) {
	return {
		readerAccountId: ACCOUNT,
		articleId,
		source: {
			owner: { kind: "global", id: "00000000-0000-0000-0000-000000000000" },
			publishedRevisionId: id(),
			revision: "1",
		},
		scrollRatio: 1,
		readAt: now(),
	};
}

function world(persona: Persona): World {
	const w: World = {
		persona,
		accountRevision: "1",
		registration: "pending",
		offer: null,
		plantName: null,
		resume: null,
		declared: false,
		scheduleRevision: null,
		discovery: null,
		replays: new Map(),
	};
	const plant = () => {
		w.plantName = "Harvest Point";
		w.resume = freshResume(id());
		w.registration = "active";
	};
	switch (persona) {
		case "planter":
			w.offer = "planter";
			break;
		case "either":
			w.offer = "either";
			w.registration = "active";
			w.accountRevision = "4";
			break;
		case "discovery-new":
			w.offer = "discovery";
			break;
		case "discovery":
			w.registration = "active";
			w.accountRevision = "2";
			w.discovery = {
				discoveryId: id(),
				revision: "1",
				relationships: [
					relationship(ORG_A, "sending_church", { people: true, meetings: true }),
					relationship(ORG_B, "sending_network", {}),
				],
				reading: { readerAccountId: ACCOUNT, articles: [reading(ARTICLE_1), reading(ARTICLE_2)] },
				documentProposals: [],
			};
			break;
		case "created":
			plant();
			break;
		case "resume":
			plant();
			Object.assign(w.resume!, {
				revision: "3",
				journey: { status: "saved", value: { answer: "unsure" }, savedAt: now() },
				launch: { status: "saved", value: { answer: "no_date" }, savedAt: now() },
			});
			break;
		case "declared":
			plant();
			w.declared = true;
			w.scheduleRevision = "1";
			Object.assign(w.resume!, {
				revision: "3",
				currentPhase: 3,
				journey: { status: "saved", value: { answer: "existing", phase: 3 }, savedAt: now() },
				launch: {
					status: "saved",
					value: { answer: "planned", date: "2027-09-12", expectedScheduleRevision: "1" },
					savedAt: now(),
				},
				scheduledLaunchDate: "2027-09-12",
			});
			break;
		case "finished":
			plant();
			Object.assign(w.resume!, {
				revision: "5",
				materialRevision: "5",
				journey: { status: "saved", value: { answer: "skip" }, savedAt: now() },
				launch: { status: "saved", value: { answer: "skip" }, savedAt: now() },
				lead: { answer: "no", savedAt: now() },
				completion: { status: "completed", completedAt: now(), materialRevision: "5" },
			});
			break;
		default:
			break;
	}
	return w;
}

function entryOf(w: World): unknown {
	if (w.persona === "member") return { kind: "elsewhere", reason: "member" };
	if (w.persona === "organization") return { kind: "elsewhere", reason: "organization" };
	if (w.persona === "unavailable") return { kind: "elsewhere", reason: "unavailable" };
	if (w.persona === "email") return { kind: "confirm_email" };
	if (w.resume) return { kind: "plant", plantName: w.plantName, resume: C.resumeResult.parse(w.resume) };
	if (w.discovery) return { kind: "discovery", profile: w.discovery };
	if (w.offer) return { kind: "start", offer: w.offer, accountRevision: w.accountRevision };
	return { kind: "elsewhere", reason: "unavailable" };
}

class Refused extends Error {
	constructor(readonly code: ErrorCode) {
		super(code);
	}
}
const refuse = (code: ErrorCode): never => {
	throw new Refused(code);
};

function create(w: World, op: "createPlant" | "convertDiscovery", cmd: Command, input: Raw) {
	if (w.resume) refuse("active_seat_conflict");
	if (op === "createPlant" && w.discovery) refuse("association_resolution_required");
	const expected = op === "createPlant" ? w.accountRevision : String(w.discovery?.revision);
	if (cmd.expectedRevision !== expected) refuse("conflict");
	const plantId = id();
	w.plantName = String(input.name);
	w.resume = freshResume(plantId);
	w.registration = "active";
	w.accountRevision = String(Number(w.accountRevision) + 1);

	const creation = { kind: "church_creation", eventId: id(), fromPhase: null, toPhase: 1, recordedAt: now() };
	const base = {
		plant: { kind: "plant", id: plantId },
		revision: "1",
		materialRevision: "1",
		ownerSeat: { seatId: id(), role: "owner", personId: id() },
		creation,
		currentPhase: 1,
	};
	if (op === "createPlant") return { status: "created", ...base, initialSharing: OFF };
	const d = w.discovery!;
	const kept = (input.relationships as Raw[]).map((s) => ({
		relationshipId: id(),
		organization: s.organization,
		revision: "1",
		consentRevision: "1",
		choices: s.choices,
	}));
	w.discovery = null;
	return {
		status: "converted",
		...base,
		discoveryId: d.discoveryId,
		relationships: kept,
		convertedAt: now(),
		documentProposals: [],
	};
}

function apply(w: World, op: Op, cmd: Command): unknown {
	const input = cmd.input as Raw;
	if (op === "createPlant") {
		if (w.offer === "discovery") refuse("unavailable");
		return C.createPlantResult.parse(create(w, op, cmd, input));
	}
	if (op === "convertDiscovery") {
		if (!w.discovery) refuse("unavailable");
		return C.convertDiscoveryResult.parse(create(w, op, cmd, input));
	}
	if (op === "createDiscovery") {
		if (w.offer === "planter" || w.discovery || w.resume) refuse("unavailable");
		if (cmd.expectedRevision !== w.accountRevision) refuse("conflict");
		w.discovery = {
			discoveryId: id(),
			revision: "1",
			relationships: [],
			reading: { readerAccountId: ACCOUNT, articles: [] },
			documentProposals: [],
		};
		w.registration = "active";
		w.offer = null;
		return C.createDiscoveryResult.parse({ status: "active", profile: w.discovery });
	}
	const resume = w.resume ?? refuse("unavailable");
	if (cmd.expectedRevision !== resume.revision) refuse("conflict");
	const plant = resume.plant as Raw;
	const bump = () => (resume.revision = String(Number(resume.revision) + 1));
	if (op === "declareJourney") {
		const journey = input.journey as Raw;
		const launch = input.launch as Raw;
		if (journey.answer === "existing") {
			if (w.declared) refuse("already_declared");
			w.declared = true;
			resume.currentPhase = journey.phase;
		}
		if (launch.answer === "planned") {
			if (launch.expectedScheduleRevision !== (w.scheduleRevision ?? "1")) refuse("conflict");
			w.scheduleRevision = w.scheduleRevision ? String(Number(w.scheduleRevision) + 1) : "1";
			resume.scheduledLaunchDate = launch.date;
		}
		const at = now();
		resume.journey = { status: "saved", value: journey, savedAt: at };
		resume.launch = { status: "saved", value: launch, savedAt: at };
		bump();
		return C.journeyResult.parse({
			plant,
			revision: resume.revision,
			currentPhase: resume.currentPhase,
			journey: resume.journey,
			launch: resume.launch,
			scheduledLaunchDate: resume.scheduledLaunchDate,
		});
	}
	if (op === "answerLead") {
		const at = now();
		resume.lead =
			input.answer === "yes"
				? { answer: "yes", assignment: { teamId: id(), roleId: id(), personId: id() }, savedAt: at }
				: { answer: input.answer, savedAt: at };
		bump();
		return C.leadAnswerResult.parse({ plant, revision: resume.revision, lead: resume.lead });
	}
	const completion = resume.completion as Raw;
	if (completion.status !== "completed") {
		bump();
		resume.materialRevision = resume.revision;
		resume.completion = { status: "completed", completedAt: now(), materialRevision: resume.materialRevision };
	}
	return C.completeOnboardingResult.parse({
		plant,
		revision: resume.revision,
		completion: resume.completion,
	});
}

export type Call = { op: Op; requestKey: string; command: Command };
export type FixtureControls = {
	calls: Call[];
	failNext(op: Op, code: ErrorCode): void;
	/** Another tab or person changes the facts, so the next write meets a newer revision. */
	bumpRevision(): void;
};

/** A fixture port for one persona and page load. `delay` is the reply time in milliseconds. */
export function createFixturePort(
	persona: Persona,
	{ delay }: { delay: number },
): {
	port: OnboardingPort;
	entry: Entry;
	controls: FixtureControls;
} {
	const w = world(persona);
	const faults = new Map<Op, ErrorCode>();
	const calls: Call[] = [];
	const wait = () => new Promise((r) => setTimeout(r, delay));
	const port = createPort({
		async entry() {
			await wait();
			return entryOf(w);
		},
		async command(op, cmd) {
			calls.push({ op, requestKey: cmd.requestKey, command: cmd });
			await wait();
			const fault = faults.get(op);
			const error = (code: ErrorCode) => ({
				status: "refused",
				error: { code, details: {}, correlationId: id(), retry: RETRY[code] },
			});
			if (fault) {
				faults.delete(op);
				return error(fault);
			}
			const digest = stable({ op, cmd });
			const replay = w.replays.get(cmd.requestKey);
			if (replay)
				return replay.digest === digest ? { status: "ok", value: replay.value } : error("idempotency_conflict");
			try {
				const value = apply(w, op, cmd);
				w.replays.set(cmd.requestKey, { digest, value });
				return { status: "ok", value };
			} catch (e) {
				if (e instanceof Refused) return error(e.code);
				throw e;
			}
		},
	});
	const load = parseEntry(entryOf(w));
	const parsed: Entry = load.kind === "entry" ? load.entry : { kind: "elsewhere", reason: "unavailable" };
	return {
		port,
		entry: parsed,
		controls: {
			calls,
			failNext: (op, code) => void faults.set(op, code),
			bumpRevision() {
				if (w.resume) w.resume.revision = String(Number(w.resume.revision) + 1);
				else w.accountRevision = String(Number(w.accountRevision) + 1);
			},
		},
	};
}
