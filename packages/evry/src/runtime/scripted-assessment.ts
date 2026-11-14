import * as c from "@everyfield/contracts/intelligence";
import { ProviderBusy, type DraftCall, type Drafter, type DraftReply } from "@everyfield/domain/intelligence";

// The scripted assessment model (WP-042) and the scripted language judge (PI-036), for local previews, tests and CI
// only (D77: automated tests make no paid calls). The drafter writes a grounded draft from the run's own input the way
// a careful model would: exact numbers from the cited facts, Unknown said as unknown, one passage per point where the
// search found one. A test script can change any draft to prove the checks reject it. There is no paid assessment model:
// a real one needs Sebastian's G-SPEND approval and a plan item first.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-03" as "Oct 3". */
export const shortDate = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

type Topic = c.FactTopic | "coverage";
type Line = { topic: Topic; state: "concern" | "neutral" | "good"; title: string; body: string; facts: string[] };
const STEM: Record<Topic, RegExp> = {
	committedAdults: /commit|core group/i,
	growth: /grow|momentum/i,
	vision: /vision/i,
	cohesion: /cohesion|attend|engag/i,
	followUps: /follow|guest/i,
	coverage: /ministr|leader|responsib/i,
	training: /train/i,
};

/** What the facts say about each topic, in plain words that use only the cited values. */
function lines(input: c.ModelInput): Line[] {
	const f = new Map(input.facts.map((x) => [x.key, x.value]));
	const v = (key: string) => f.get(key);
	const out: Line[] = [];
	const adults = v("committedAdults.status");
	if (adults === "unknown")
		out.push({
			topic: "committedAdults",
			state: "concern",
			title: "Your committed-adult count is unknown",
			body: `Your committed-adult count is unknown right now. ${v("committedAdults.needsClassifying")} of the people with a commitment card need an adult or child classification, and recording a birth date or a classification for each would settle it.`,
			facts: ["committedAdults.status", "committedAdults.needsClassifying"],
		});
	else
		out.push({
			topic: "committedAdults",
			state: adults === "met" ? "good" : "concern",
			title: adults === "met" ? "Your core group has reached its size" : "Keep growing the committed core",
			body:
				adults === "met"
					? `Your records show ${v("committedAdults.count")} committed adults, which meets the committed-adult target of ${v("committedAdults.target")}.`
					: `Your records show ${v("committedAdults.count")} committed adults, and the committed-adult target is ${v("committedAdults.target")}. You might look at who has been coming to Vision meetings and is close to committing.`,
			facts: ["committedAdults.count", "committedAdults.target", "committedAdults.status"],
		});
	const interviews = v("humanRecords.interviews");
	const latest = v("humanRecords.interviewsLatestOn");
	if (typeof interviews === "number" && interviews > 0 && typeof latest === "string")
		out.push({
			topic: "committedAdults",
			state: "good",
			title: "Interviews are on record",
			body: `${interviews} interviews recorded, latest ${shortDate(latest)}.`,
			facts: ["humanRecords.interviews", "humanRecords.interviewsLatestOn"],
		});
	const growth = v("growth.status");
	out.push(
		growth === "unknown"
			? {
					topic: "growth",
					state: "neutral",
					title: "Growth isn't measured yet",
					body: "Growth is unknown until a committed adult has a first commitment date on their card.",
					facts: ["growth.status"],
				}
			: {
					topic: "growth",
					state: growth === "on_track" ? "good" : "concern",
					title: growth === "on_track" ? "New adults keep joining" : "Momentum has slowed",
					body: `The newest adult commitment was ${v("growth.daysSince")} days ago, and ${v("growth.current")} ${v("growth.current") === 1 ? "adult" : "adults"} committed in the last ${v("growth.stalledDays")} days.`,
					facts: ["growth.status", "growth.daysSince", "growth.current", "growth.stalledDays"],
				},
	);
	const vision = v("vision.status");
	const held = v("vision.lastHeldOn");
	out.push(
		vision === "unknown" || typeof held !== "string"
			? {
					topic: "vision",
					state: "concern",
					title: "Vision meeting rhythm is unknown",
					body: "There is no Vision meeting attendance recorded yet, so the rhythm is unknown. Recording who came to the next one would show it.",
					facts: ["vision.status"],
				}
			: {
					topic: "vision",
					state: vision === "on_target" ? "good" : "concern",
					title: vision === "on_target" ? "Vision meetings are on rhythm" : "Set the next Vision meeting",
					body: `Your last Vision meeting was on ${shortDate(held)}, ${v("vision.daysSince")} days ago. The rhythm aims for one every ${v("vision.targetDays")} days.`,
					facts: ["vision.status", "vision.lastHeldOn", "vision.daysSince", "vision.targetDays"],
				},
	);
	const filled = v("coverage.filled");
	out.push({
		topic: "coverage",
		state: v("coverage.status") === "met" ? "good" : "concern",
		title:
			v("coverage.status") === "met"
				? "Every ministry responsibility has someone"
				: "Fill the open ministry responsibilities",
		body: `${filled} of ${v("coverage.slots")} ministry responsibilities have someone in them.`,
		facts: ["coverage.filled", "coverage.slots", "coverage.status"],
	});
	const training = v("training.status");
	out.push(
		training === "unknown"
			? {
					topic: "training",
					state: "neutral",
					title: "Required training isn't assigned yet",
					body: "No required training is assigned yet, so training progress is unknown.",
					facts: ["training.status"],
				}
			: {
					topic: "training",
					state: training === "met" ? "good" : "concern",
					title: training === "met" ? "Required training is complete" : "Finish the required training",
					body: `${v("training.complete")} of ${v("training.total")} required training assignments are complete.`,
					facts: ["training.complete", "training.total", "training.status"],
				},
	);
	out.push(
		v("followUps.status") === "unknown"
			? {
					topic: "followUps",
					state: "neutral",
					title: "Follow-up timing isn't measured yet",
					body: "No follow-up has been measured yet, so follow-up timing is unknown. Recording when each guest is contacted would show it.",
					facts: ["followUps.status"],
				}
			: {
					topic: "followUps",
					state: v("followUps.onTime") === v("followUps.measured") ? "good" : "concern",
					title: "Follow up with guests within two days",
					body: `${v("followUps.onTime")} of ${v("followUps.measured")} follow-ups were done within ${v("followUps.windowHours")} hours. You might look at who is waiting for a call.`,
					facts: ["followUps.onTime", "followUps.measured", "followUps.windowHours"],
				},
	);
	return out;
}

/** The grounded draft for an input: one focus, two supporting points and what's going well. */
export function scriptedDraft(input: c.ModelInput): c.DraftOutput {
	const all = lines(input);
	const used = new Set<string>();
	const point = (l: Line): c.DraftPoint => {
		const p = input.passages.find((x) => STEM[l.topic].test(x.text) && !used.has(x.key));
		if (p) used.add(p.key);
		const urgency = l.state === "concern" ? "watch" : l.state === "neutral" ? "info" : "positive";
		return { title: l.title, body: l.body, urgency, citations: [...l.facts, ...(p ? [p.key] : [])] };
	};
	const ordered = (["concern", "neutral", "good"] as const).flatMap((state) => all.filter((l) => l.state === state));
	const [focus, a, b] = ordered;
	const positives = all.filter((l) => l.state === "good" && l !== focus && l !== a && l !== b).slice(0, 3);
	return {
		summary: `This looks at your launch progress in Phase ${input.phase}. The main thing to look at now: ${focus!.title.toLowerCase()}.`,
		focus: point(focus!),
		supporting: [point(a!), point(b!)],
		positives: positives.map(point),
	};
}

const tokens = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4);

/** A scripted provider reply before the draft: busy (429 with an optional Retry-After in seconds, or a 5xx). */
export type ScriptedReply = { status: 429 | 500 | 502 | 503; retryAfterSeconds?: number };

/**
 * The scripted drafter. `script(draft, call)` may return a changed draft (or anything at all, to test the shape check)
 * for any call; `failures` makes the first calls fail as an uncertain provider error would; `busy` answers the first
 * calls as a busy provider would, one reply per call; `during(call)` runs before each reply, so a test can change
 * records while a draft is in flight. Every call is one dispatch: there is no hidden retry.
 */
export function scriptedAssessmentDrafter(
	options: {
		script?: (draft: c.DraftOutput, call: DraftCall) => unknown;
		failures?: number;
		busy?: ScriptedReply[];
		during?: (call: DraftCall) => Promise<void>;
	} = {},
): Drafter & { calls: DraftCall[] } {
	let failures = options.failures ?? 0;
	const busy = [...(options.busy ?? [])];
	const calls: DraftCall[] = [];
	return {
		id: "assessment-scripted",
		calls,
		async draft(call): Promise<DraftReply> {
			calls.push(call);
			await options.during?.(call);
			const reply = busy.shift();
			if (reply)
				throw new ProviderBusy(
					reply.status,
					reply.retryAfterSeconds === undefined ? null : reply.retryAfterSeconds * 1000,
				);
			if (failures > 0) {
				failures--;
				throw new Error("scripted provider unavailable");
			}
			const draft = scriptedDraft(call.input);
			const output = options.script ? options.script(draft, call) : draft;
			return { output, usage: { inputTokens: tokens(call), outputTokens: tokens(output) } };
		},
	};
}

const HYPE =
	/!|\b(amazing|incredible|explosive|skyrocket\w*|game[- ]chang\w*|crush\w*|massive|unstoppable|huge win)\b/gi;
const PRESSURE =
	/\b(you must|must act|immediately|urgent(?:ly)?|act now|before it's too late|falling behind|you're behind|no excuses)\b/gi;
const NEXT_STEP = /\b(might|could|consider|try|look at|record|recording|ask|invite|set|fill|finish)\b/i;

/**
 * The scripted graded judge: plain (short sentences), warm (speaks to the planter), useful (each point offers a next
 * step), with every hype or pressure phrase listed as a failure. Deterministic, so a report is reproducible.
 */
export function scriptedLanguageJudge(draft: c.DraftOutput): c.LanguageGrade {
	const points = [draft.focus, ...draft.supporting, ...draft.positives];
	const text = [draft.summary, ...points.flatMap((p) => [p.title, p.body])].join(" ");
	const words = text.split(/\s+/).filter(Boolean).length;
	const sentences = Math.max(1, text.split(/[.!?]+\s/).length);
	const perSentence = words / sentences;
	const plain = perSentence <= 18 ? 5 : perSentence <= 24 ? 4 : perSentence <= 30 ? 3 : 2;
	const warm = /\byou(r)?\b/i.test(text) ? 5 : 2;
	const concerns = [draft.focus, ...draft.supporting];
	const stepped = concerns.filter((p) => NEXT_STEP.test(p.body)).length;
	const useful = stepped >= 2 ? 5 : stepped === 1 ? 4 : 2;
	const failures = [
		...[...text.matchAll(HYPE)].map((m) => ({ rule: "hype" as const, quote: m[0] })),
		...[...text.matchAll(PRESSURE)].map((m) => ({ rule: "pressure" as const, quote: m[0] })),
	];
	return c.languageGrade.parse({ plain, warm, useful, failures });
}
