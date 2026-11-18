import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import * as c from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import { ModelUnavailable, ProviderBusy, type Drafter } from "@everyfield/domain/intelligence";
import { APICallError } from "ai";
import { EvryRefusal } from "../context/errors.ts";
import { paidModel, type Spend } from "./model.ts";
import { inputTokenBound, meteredModel } from "./spend.ts";

const DRAFT_SYSTEM = `You write a short launch-progress assessment for a church planter, as JSON only.
The user message is JSON: "input" holds the plant's phase, today's date, measured facts (key, label, value, status) and methodology passages (key, title, section, text); "feedback" lists the rules the previous draft broke, if any. Fix every one of them.
Reply with one JSON object and nothing else:
{"summary": string, "focus": Point, "supporting": [Point, Point], "positives": [Point, ...at most 3]}
Point = {"title": string (3-140 chars), "body": string (10-1200 chars), "urgency": "positive"|"info"|"watch"|"urgent", "citations": [fact or passage keys]}
Rules:
- "focus" is the one thing to look at now; "supporting" are two more points; "positives" is what is going well.
- Every point cites at least one fact key or passage key from the input, and only keys from the input.
- Every number and date you write must be a value of a fact you cite. Do not compute, round or invent numbers or dates.
- A fact whose value is null is Unknown: say it is unknown and what would settle it. Never compare it with a target.
- Talk only about launch progress. Never judge anyone's character, spiritual state or church health, and never say the plant is or is not ready to launch.
- You cannot act. Never say you created, sent, scheduled or changed anything.
- Never mention interviews' content, notes, scores or check-ins; only the counts and dates the facts give.
- Plain, warm, useful words to the planter ("you", "your"), with a gentle next step. No hype, no exclamation marks, no pressure or urgency words.`;

const JUDGE_SYSTEM = `You grade the wording of a launch-progress assessment written to a church planter. Reply with JSON only.
The user message is JSON: "draft" holds a summary and points with titles and bodies.
Grade three scales from 1 (poor) to 5 (excellent):
- plain: short, clear sentences in everyday words, no jargon.
- warm: speaks kindly and directly to the planter.
- useful: each concern offers a concrete, gentle next step.
List every hype phrase and every pressure phrase as a failure, quoting the exact words from the draft:
- hype: exaggerated praise or excitement ("amazing", "incredible", "crushing it") and exclamation marks.
- pressure: urgency, guilt, obligation or threat ("you must", "immediately", "urgent", "falling behind", "you are failing", a deadline used as a threat).
A gentle suggested next step is not pressure, even when it is phrased as an imperative ("Review the remaining roles", "Fill the open responsibilities"). A plain statement of fact is not hype. List nothing that is not hype or pressure; an empty list is the right answer for a calm draft.
Reply with exactly: {"plain": int, "warm": int, "useful": int, "failures": [{"rule": "hype"|"pressure", "quote": string}]}`;

export type JudgeResult = { status: "graded"; grade: c.LanguageGrade } | { status: "judge_failed"; detail: string };
export type LanguageJudge = (draft: c.DraftOutput, signal?: AbortSignal) => Promise<JudgeResult>;

const JUDGE_OUTPUT_TOKENS = 2000;
const JUDGE_MS = c.ASSESSMENT_BUDGET.callMs;

function retryAfterMs(headers: Record<string, string> | undefined) {
	const seconds = Number(headers?.["retry-after"]);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

async function dispatch(
	model: LanguageModelV4,
	system: string,
	payload: unknown,
	maxOutputTokens: number,
	signal: AbortSignal,
) {
	try {
		const params: LanguageModelV4CallOptions = {
			prompt: [
				{ role: "system", content: system },
				{ role: "user", content: [{ type: "text", text: JSON.stringify(payload) }] },
			],
			maxOutputTokens,
			responseFormat: { type: "json" },
			abortSignal: signal,
		};
		const r = await model.doGenerate(params);
		const text = r.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
		return { text, usage: r.usage, inputBound: inputTokenBound(params) };
	} catch (error) {
		if (error instanceof EvryRefusal && error.code === "model_unavailable") throw new ModelUnavailable();
		if (APICallError.isInstance(error) && error.statusCode !== undefined) {
			if (error.statusCode === 429 || error.statusCode >= 500)
				throw new ProviderBusy(error.statusCode, retryAfterMs(error.responseHeaders));
		}
		throw error;
	}
}

const parsed = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};

export function assessmentDrafter(model: LanguageModelV4, id: string): Drafter {
	return {
		id,
		async draft(call, signal) {
			const payload = { input: call.input, feedback: call.feedback };
			const { text, usage, inputBound } = await dispatch(model, DRAFT_SYSTEM, payload, call.maxOutputTokens, signal);
			return {
				output: parsed(text),
				usage: {
					inputTokens: usage.inputTokens.total ?? inputBound,
					outputTokens: usage.outputTokens.total ?? call.maxOutputTokens,
				},
			};
		},
	};
}

export function languageJudge(model: LanguageModelV4): LanguageJudge {
	return async (draft, signal = AbortSignal.timeout(JUDGE_MS)) => {
		let text: string;
		try {
			({ text } = await dispatch(model, JUDGE_SYSTEM, { draft }, JUDGE_OUTPUT_TOKENS, signal));
		} catch (error) {
			const detail =
				error instanceof ModelUnavailable || error instanceof ProviderBusy ? error.message : "provider_error";
			return { status: "judge_failed", detail };
		}
		const grade = c.languageGrade.safeParse(parsed(text));
		return grade.success
			? { status: "graded", grade: grade.data }
			: { status: "judge_failed", detail: `unparseable reply: ${text.slice(0, 200)}` };
	};
}

export function meteredAssessment(db: Database, model: LanguageModelV4, id: string, spend: Spend) {
	const meter = meteredModel(db, model, spend);
	return { id, drafter: assessmentDrafter(meter.model, id), judge: languageJudge(meter.model), charged: meter.charged };
}

export function paidAssessment(db: Database, env: Record<string, string | undefined> = process.env) {
	if (env.EVRY_SCRIPTED_MODEL === "1") return null;
	const paid = paidModel(env);
	return paid && meteredAssessment(db, paid.model, paid.id, paid.spend);
}
