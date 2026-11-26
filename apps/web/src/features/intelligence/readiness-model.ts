import {
	READINESS_QUESTION_VERSION,
	TEXT_MAX,
	textOf,
	type ReadinessEntry,
	type ReadinessKey,
	type ReadinessRevision,
	type readinessWriteResult,
	type SignalError,
} from "@everyfield/contracts/intelligence";
import type { z } from "zod";
import { refusalText, type SignalOutcome } from "./signals-model.ts";

export type ReadinessWriteResult = z.output<typeof readinessWriteResult>;

export type ReadinessView = {
	today: string;
	attestations: ReadinessEntry[];
	history: ReadinessRevision[];
	people: { id: string; displayName: string }[];
};

export const READINESS = {
	relationship: {
		title: "Sending relationship",
		description: "A real sending church or network that stands with this plant.",
		named: "Organization",
		namedHint: "The sending church or network, by name.",
		note: "Mentor",
		noteHint: "A person there who walks with you.",
		missing: "Name the organization.",
	},
	worship_agreement: {
		title: "Worship leader",
		description: "A named person of the church who agreed to lead worship.",
		named: "Person",
		namedHint: "Anyone in your church's People list, with or without an account.",
		note: "Statement",
		noteHint: "What they agreed to, in your words.",
		missing: "Choose the person who agreed.",
	},
	community: {
		title: "Chosen community",
		description: "The neighborhood, town or area the church is planted in.",
		named: "Community",
		namedHint: "The community, as you name it.",
		note: "Plan reference",
		noteHint: "Where the plan for it lives, such as a document or meeting.",
		missing: "Name the community.",
	},
} as const satisfies Record<ReadinessKey, Record<string, string>>;

export type ReadinessDraft = { named: string; note: string; asOf: string };
export type DraftProblems = Partial<Record<keyof ReadinessDraft, string>>;

const noteOf = (entry: Pick<ReadinessEntry, "statement" | "reference">) => entry.statement ?? entry.reference ?? "";
const namedValue = (entry: Pick<ReadinessEntry, "key" | "named" | "personId">) =>
	(entry.key === "worship_agreement" ? entry.personId : entry.named) ?? "";

export function draftOf(entry: ReadinessEntry, today: string): ReadinessDraft {
	if (entry.state !== "answered") return { named: "", note: "", asOf: today };
	return { named: namedValue(entry), note: noteOf(entry), asOf: entry.asOf ?? today };
}

const TOO_LONG = `Keep it to ${TEXT_MAX.toLocaleString("en-US")} characters or fewer.`;
export function problemsOf(key: ReadinessKey, draft: ReadinessDraft, today: string): DraftProblems {
	const problems: DraftProblems = {};
	const named = draft.named.trim();
	if (!named) problems.named = READINESS[key].missing;
	else if (named.length > TEXT_MAX) problems.named = TOO_LONG;
	if (draft.note.length > TEXT_MAX) problems.note = TOO_LONG;
	if (!draft.asOf) problems.asOf = "Choose the date it is true as of.";
	else if (draft.asOf > today) problems.asOf = "A statement cannot be dated after today.";
	return problems;
}

export function inputOf(key: ReadinessKey, draft: ReadinessDraft) {
	const named = draft.named.trim();
	const { note, asOf } = draft;
	switch (key) {
		case "relationship":
			return { key, organization: named, mentor: note, asOf };
		case "worship_agreement":
			return { key, personId: named, statement: note, asOf };
		case "community":
			return { key, area: named, plan: note, asOf };
	}
}

export function intentOf(entry: ReadinessEntry, draft: ReadinessDraft): "attest" | "correct" | "none" {
	if (entry.state !== "answered") return "attest";
	const same =
		draft.named.trim() === namedValue(entry) &&
		(textOf(draft.note) ?? "") === noteOf(entry) &&
		draft.asOf === entry.asOf;
	return same ? "none" : "correct";
}

const bump = (revision: string) => String(BigInt(revision) + 1n) as ReadinessEntry["revision"];

export function recorded(
	entry: ReadinessEntry,
	draft: ReadinessDraft,
	people: ReadinessView["people"],
	authorName: string,
	recordedAt: string,
): ReadinessEntry {
	const named = draft.named.trim();
	const note = textOf(draft.note);
	const worship = entry.key === "worship_agreement";
	return {
		...entry,
		state: "answered",
		asOf: draft.asOf as ReadinessEntry["asOf"],
		named: worship ? (people.find((p) => p.id === named)?.displayName ?? null) : named,
		personId: worship ? (named as ReadinessEntry["personId"]) : null,
		statement: worship ? note : null,
		reference: worship ? null : note,
		authorName,
		recordedAt: recordedAt as ReadinessEntry["recordedAt"],
		revision: bump(entry.revision),
	};
}

export function retracted(
	entry: ReadinessEntry,
	today: string,
	authorName: string,
	recordedAt: string,
): ReadinessEntry {
	return {
		...entry,
		state: "retracted",
		asOf: today as ReadinessEntry["asOf"],
		named: null,
		personId: null,
		statement: null,
		reference: null,
		authorName,
		recordedAt: recordedAt as ReadinessEntry["recordedAt"],
		revision: bump(entry.revision),
	};
}

export function historyLine(
	confirmed: ReadinessEntry,
	kind: ReadinessRevision["kind"],
	before: ReadinessEntry,
): ReadinessRevision {
	if (confirmed.asOf === null || confirmed.recordedAt === null) throw new Error(`${confirmed.key} was never recorded`);
	const values = kind === "retracted" ? before : confirmed;
	return {
		id: crypto.randomUUID() as ReadinessRevision["id"],
		key: confirmed.key,
		revision: Number(confirmed.revision),
		kind,
		asOf: confirmed.asOf,
		named: values.named,
		personId: values.personId,
		statement: values.statement,
		reference: values.reference,
		authorName: confirmed.authorName,
		recordedAt: confirmed.recordedAt,
		questionVersion: READINESS_QUESTION_VERSION,
	};
}

export function withReadiness(view: ReadinessView, entry: ReadinessEntry, line?: ReadinessRevision): ReadinessView {
	return {
		...view,
		attestations: view.attestations.map((a) => (a.key === entry.key ? entry : a)),
		history: line ? [line, ...view.history] : view.history,
	};
}

export const historyOf = (view: ReadinessView, key: ReadinessKey) => view.history.filter((h) => h.key === key);

export function entryOf(view: ReadinessView, key: ReadinessKey): ReadinessEntry {
	const entry = view.attestations.find((a) => a.key === key);
	if (!entry) throw new Error(`The readiness section has no ${key} attestation`);
	return entry;
}

export const STATE_LABEL: Record<ReadinessEntry["state"], string> = {
	answered: "Recorded",
	retracted: "Retracted",
	unanswered: "Not recorded",
};
export const KIND_LABEL: Record<ReadinessRevision["kind"], string> = {
	answered: "Recorded",
	corrected: "Corrected",
	retracted: "Retracted",
};
export function noteLine(entry: Pick<ReadinessEntry, "key" | "statement" | "reference">): string | null {
	const note = noteOf(entry);
	return note ? `${READINESS[entry.key].note}: ${note}` : null;
}

export const actionLabel = (entry: ReadinessEntry) =>
	entry.state === "answered" ? "Correct" : entry.state === "retracted" ? "Record again" : "Record";

export function readinessRefusal(error: SignalError | null): string {
	switch (error?.code) {
		case "revision_conflict":
			return "Another Owner or Admin changed this first. Load the latest to see it, then try again. What you typed is still here.";
		case "not_current":
			return "There is nothing current to change. Load the latest to see where it stands.";
		case "no_change":
			return "That is what it already says. Change a value or the date to correct it.";
		case "not_found":
			return "That person is not in your church's current People list. Choose someone else.";
		case "invalid_input":
			return "Check the date and the text. A statement cannot be dated after today.";
		case "access_denied":
			return "Your seat no longer allows this. Only an Owner or Admin of a church plant can record these.";
		default:
			return refusalText(error);
	}
}

export type Failure = { text: string; stale: boolean };

export async function settleWrite(
	entry: ReadinessEntry,
	kind: ReadinessRevision["kind"],
	optimistic: ReadinessEntry,
	send: () => Promise<SignalOutcome<ReadinessWriteResult>>,
	apply: (change: (view: ReadinessView) => ReadinessView) => void,
): Promise<Failure | null> {
	apply((v) => withReadiness(v, optimistic));
	const result = await send().catch(() => ({ status: "lost" }) as const);
	if (result.status !== "ok") {
		apply((v) => withReadiness(v, entry));
		const error = result.status === "refused" ? result.error : null;
		return {
			text: readinessRefusal(error),
			stale: error?.code === "revision_conflict" || error?.code === "not_current",
		};
	}
	const confirmed = result.value.attestation;
	apply((v) => withReadiness(v, confirmed, historyLine(confirmed, kind, entry)));
	return null;
}
