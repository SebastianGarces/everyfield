import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { dayText } from "@everyfield/contracts/common";
import { randomUUID } from "node:crypto";
import { MEMBER_PHASES } from "../catalog/catalog.ts";
import { captured } from "./captured.ts";

type Row = { id: string; label: string; fields: Record<string, unknown> };

const PHASE_NOW = /\bwhat phase are we in\b/i;
const NEXT_PHASE = /\bmove to the next phase\b/i;
const JOURNEY = /\bour journey so far\b/i;
const MOVE = /\bmove us (?:back )?to ([A-Za-z &-]+?)\.?$/i;
export const SIGNAL = /\bwe started prayer and fasting\b/i;
const CORRECT_GIVING = /\bcorrect our core group giving\b/i;
const STILL_GIVING = /\bcore group is still giving\b/i;
const PHASE_ASKS = [PHASE_NOW, NEXT_PHASE, JOURNEY, MOVE, SIGNAL, CORRECT_GIVING, STILL_GIVING];

const say = (text: string): LanguageModelV4Content[] => [{ type: "text", text }];
const call = (toolName: string, input: unknown): LanguageModelV4Content[] => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify(input) },
];
const longDay = (date: unknown) =>
	typeof date === "string"
		? dayText(date, { month: "long" })
		: "an unknown day";

function criteriaAnswer(rows: Row[]) {
	const head = rows.find((r) => !("status" in r.fields));
	const criteria = rows.filter((r) => "status" in r.fields);
	if (!criteria.length) return `${head?.label} is the last phase. It has no exit criteria.`;
	return [
		`To leave ${head?.label} for ${String(head?.fields.next)}, these are its exit criteria as Everyfield measures them:`,
		...criteria.map((r) => {
			const reading = typeof r.fields.reading === "string" ? ` (${r.fields.reading})` : "";
			return `- ${r.label}: ${String(r.fields.status)}${reading}`;
		}),
		"",
		"Moving to the next phase is your call.",
	].join("\n");
}

function journeyAnswer(rows: Row[]) {
	if (!rows.length) return "Your church's journey has no steps yet.";
	return [
		"Your church's journey, newest first:",
		...rows.map((r) => {
			const to = typeof r.fields.toDate === "string" ? ` for ${longDay(r.fields.toDate)}` : "";
			const why = typeof r.fields.reason === "string" ? `: ${r.fields.reason}` : "";
			const entry =
				r.fields.entry === "movement"
					? `Moved ${String(r.fields.direction)} to `
					: r.fields.entry === "initial_declaration"
						? "Declared as "
						: r.fields.entry === "creation"
							? "Started in "
							: "";
			return `- ${longDay(r.fields.on)}, ${entry}${r.label}${to}${why}`;
		}),
	].join("\n");
}

export function phaseStep(
	text: string,
	options: LanguageModelV4CallOptions,
	result: Record<string, unknown> | null,
): LanguageModelV4Content[] | null {
	if (!PHASE_ASKS.some((ask) => ask.test(text))) return null;
	const has = (name: string) => options.tools?.some((t) => t.name === name) ?? false;
	if (!has("phases_read")) return say(MEMBER_PHASES);
	const read = (operation: string, input: unknown = {}) => call("phases_read", { operation, input });
	const propose = (operation: string, input: unknown) => call("propose_change", { operation, input });
	if (result && typeof result.proposalId === "string")
		return say("I prepared a review. Nothing changes until you approve it.");
	const rows = (result?.rows as Row[] | undefined) ?? [];
	if (PHASE_NOW.test(text)) {
		if (!result) return read("phases.readHistory");
		const current = rows.find((r) => r.id === "current");
		return say(`You're in ${current?.label}, since ${longDay(current?.fields.since)}.`);
	}
	if (NEXT_PHASE.test(text)) return result ? say(criteriaAnswer(rows)) : read("intelligence.readExitCriteria");
	if (JOURNEY.test(text)) return result ? say(journeyAnswer(rows)) : read("intelligence.readJourney");
	const move = MOVE.exec(text);
	if (move) {
		if (!result) return read("phases.readCatalog");
		const to = rows.find((r) => r.label.toLowerCase() === captured(move, 1).trim().toLowerCase());
		if (!to) return say(`I can't find a phase called ${move[1]}.`);
		return propose("phases.transition", { toPhase: Number(to.id), reason: text });
	}
	if (!has("propose_change")) return null;
	const today = new Date().toISOString().slice(0, 10);
	if (SIGNAL.test(text))
		return propose("signals.attest", { key: "prayer_rhythm_established", value: "yes", asOf: today, detail: text });
	if (CORRECT_GIVING.test(text))
		return propose("signals.correct", {
			action: "correct",
			key: "core_group_giving",
			value: "not_yet",
			asOf: today,
			detail: text.replace(/^.*?:\s*/, ""),
		});
	return propose("signals.reaffirm", { key: "core_group_giving" });
}
