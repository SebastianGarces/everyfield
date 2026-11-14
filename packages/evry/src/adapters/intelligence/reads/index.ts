import * as signalsContract from "@everyfield/contracts/intelligence";
import * as c from "@everyfield/contracts/phases";
import { createSignals } from "@everyfield/domain/intelligence";
import { phaseReader, readCatalog, readReadiness } from "@everyfield/domain/phases";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";

// The phase and manual-signal reads (WP-073 over WP-038 and WP-039). Each calls the native read the phase journey and
// the Attestations page use, under the actor's live authority. Only an Owner or Admin of the selected church reads
// them: a Member's seat does not include the phase journey, and an organization or account context has no plant phase.
// Private weekly check-ins have no adapter, and no read here touches private care.

/** The Owner or Admin of the selected church, the floor of every phases.* and signals.* operation. */
export const ownerOrAdmin = (actor: EvryActor) =>
	actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");

type Reply<T> = { status: "ok"; value: T } | { status: "refused"; error: { code: string } };
/** A refused native read: the seat ended or changed since the turn started. */
function valueOf<T>(reply: Reply<T>): T {
	if (reply.status === "ok") return reply.value;
	throw new EvryRefusal(reply.error.code === "access_denied" ? "access_denied" : "source_unavailable");
}
const complete = (operation: string, rows: SourceRow[], exclusions: string[] = []): SourceResult => ({
	operation,
	status: "available",
	rows,
	total: rows.length,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions,
});

/** A phase's number and name, as the journey says it: "1 Core Group Development". */
const phaseName = (catalog: c.Catalog, phase: number) => catalog.phases.find((p) => p.phase === phase)!.name;
/** The church's calendar day of an instant: "2026-08-03". */
const localDay = (at: string, zone: string) =>
	new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
		new Date(at),
	);
/** What a criterion's status means, in the words Evry must use: no measured data is never "not met". */
export const STATUS_WORDS: Record<c.CriterionStatus, string> = {
	met: "met",
	not_met: "not met",
	unknown: "no data yet",
	not_tracked: "not tracked",
};
const signals = createSignals();
const signalLabel = (key: string) => signalsContract.SIGNAL_DEFINITIONS.find((d) => d.key === key)?.label ?? key;

const none = z.strictObject({});

const readPhaseCatalog: ReadAdapter<z.infer<typeof none>> = {
	operation: "phases.readCatalog",
	description:
		"List the seven church planting phases in order, each with the exit criteria for leaving it. Reference only: it says nothing about this church.",
	input: none,
	allowed: ownerOrAdmin,
	async invoke() {
		const catalog = await readCatalog();
		return complete(
			"phases.readCatalog",
			catalog.phases.map((p) => ({
				kind: "phase",
				id: String(p.phase),
				label: p.name,
				fields: {
					phase: String(p.phase),
					terminal: p.terminal,
					exitCriteria: p.criteria.map((x) => x.label).join("; ") || null,
				},
			})),
		);
	},
};

const readHistory: ReadAdapter<z.infer<typeof none>> = {
	operation: "phases.readHistory",
	description:
		"Read this church's current phase, the day it entered it and its phase journey (the declaration when it joined and every move with its reason), oldest first. Use it to say what phase the church is in.",
	input: none,
	allowed: ownerOrAdmin,
	async invoke(tx, actor) {
		const [history, catalog] = await Promise.all([phaseReader.readHistory(tx, actor.authority), readCatalog()]);
		const h = valueOf(history);
		const zone = h.timeZone;
		const latest = h.entries.at(-1);
		const current: SourceRow = {
			kind: "phase",
			id: "current",
			label: phaseName(catalog, h.state.phase),
			fields: {
				current: true,
				phase: String(h.state.phase),
				since: latest ? localDay(latest.occurredAt, zone) : null,
				timeZone: zone,
				// True only while the church has neither declared its phase nor moved: phases.declare is then offered.
				declarable: h.state.declarable,
			},
		};
		// An entry is named by its place in the journey, which never changes: entries are only ever appended.
		const entries: SourceRow[] = h.entries.map((e, n) => ({
			kind: "phase",
			id: `entry:${n + 1}`,
			label: phaseName(catalog, e.toPhase),
			fields: {
				entry: e.kind,
				fromPhase: e.fromPhase === null ? null : phaseName(catalog, e.fromPhase),
				toPhase: phaseName(catalog, e.toPhase),
				direction: e.kind === "movement" ? e.direction : null,
				reason: e.kind === "movement" ? e.reason : null,
				by: e.actor?.displayName || null,
				on: localDay(e.occurredAt, zone),
			},
		}));
		return complete("phases.readHistory", [current, ...entries]);
	},
};

const readinessInput = z.strictObject({
	phase: c.phaseNumber.optional().describe("A phase number 0 to 6; leave it out for the church's current phase"),
});
const readReadinessAdapter: ReadAdapter<z.infer<typeof readinessInput>> = {
	operation: "phases.readReadiness",
	description:
		"Read each exit criterion for leaving a phase (the current phase unless one is named) with its status: met, not met or no data yet. Say each status as returned. Never say the church is ready, and never judge a criterion from People counts.",
	input: readinessInput,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input) {
		const [history, catalog] = await Promise.all([phaseReader.readHistory(tx, actor.authority), readCatalog()]);
		const h = valueOf(history);
		const phase = input.phase ?? h.state.phase;
		const readiness = readReadiness(catalog).find((r) => r.phase === phase)!;
		const head: SourceRow = {
			kind: "phase",
			id: String(phase),
			label: phaseName(catalog, phase),
			fields: {
				phase: String(phase),
				current: phase === h.state.phase,
				terminal: readiness.verdict === "terminal",
				// False while no criterion has a measured source: every status then reads "no data yet".
				measured: readiness.measured,
				next: phase < c.TERMINAL_PHASE ? phaseName(catalog, phase + 1) : null,
			},
		};
		const criteria: SourceRow[] = readiness.criteria.map((x) => ({
			kind: "criterion",
			id: x.key,
			label: x.label,
			fields: { phase: String(phase), status: STATUS_WORDS[x.status] },
		}));
		// The verdict stays out: Evry reports each criterion and a person decides when to move.
		return complete("phases.readReadiness", [head, ...criteria]);
	},
};

const listDefinitions: ReadAdapter<z.infer<typeof none>> = {
	operation: "signals.listDefinitions",
	description:
		"List the seven manual signals a church records, such as a corporate prayer rhythm or launch funding, with what each means and whether it is renewed every 30 days. Reference only: it says nothing about this church's answers.",
	input: none,
	allowed: ownerOrAdmin,
	async invoke() {
		const definitions = valueOf(await signals.listDefinitions({}));
		return complete(
			"signals.listDefinitions",
			definitions.map((d) => ({
				kind: "signal",
				id: d.key,
				label: d.label,
				fields: { key: d.key, description: d.description, reaffirms: d.reaffirms },
			})),
		);
	},
};

const historyInput = z.strictObject({
	key: signalsContract.signalKey.optional().describe("One signal's key; leave it out for every signal"),
});
const getHistory: ReadAdapter<z.infer<typeof historyInput>> = {
	operation: "signals.getHistory",
	description:
		"Read every recorded answer, correction, retraction and reaffirmation of this church's manual signals, newest first, with the day each is true as of and the words recorded with it. A signal with no entry has never been answered.",
	input: historyInput,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input) {
		const history = valueOf(await signals.getHistory(tx, actor.authority, { key: input.key ?? null }));
		// Leadership-candidate attestations name people and belong to the team tools, not to the signal tools.
		const rows: SourceRow[] = history.revisions
			.filter((r) => r.key !== "leadership_candidate")
			.map((r) => ({
				kind: "signal",
				// A signal's revision names the entry for good: its history is append-only.
				id: `${r.key}:${r.revision}`,
				label: signalLabel(r.key),
				fields: {
					key: r.key,
					kind: r.kind,
					value: r.value,
					asOf: r.asOf,
					detail: r.detail,
					reference: r.reference,
					by: r.authorName,
					recordedAt: r.recordedAt,
				},
			}));
		return complete("signals.getHistory", rows, ["leadership-candidate attestations"]);
	},
};

/** The phase reads, in catalog order. */
export const PHASE_READS = [readPhaseCatalog, readHistory, readReadinessAdapter] as const;
/** The manual-signal reads. */
export const SIGNAL_READS = [listDefinitions, getHistory] as const;
