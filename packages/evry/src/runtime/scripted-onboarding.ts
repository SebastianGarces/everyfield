import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";

// The scripted model's setup and Discovery requests (T-345), for local previews and tests only. It answers through the
// same tools a model gets: it reads where setup stands, then proposes a change the user reviews. A request no tool
// offers gets the product's own reply from the system prompt (compile.ts), so the evals test the text the real model is
// given, not text written here.

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { kind?: string; id: string; label: string; fields: Record<string, unknown> };
type Output = Record<string, unknown> & { rows?: Row[]; facts?: Record<string, unknown> };

const call = (toolName: string, input: unknown): LanguageModelV4Content[] => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify(input) },
];
const say = (text: string): LanguageModelV4Content[] => [{ type: "text", text }];
const propose = (operation: string, input: unknown) => call("propose_change", { operation, input });

/** The JSON tool results of the current turn, oldest first (everything after the last user message). */
function turnOutputs(prompt: Prompt): Output[] {
	const start = prompt.findLastIndex((m) => m.role === "user");
	return prompt
		.slice(start + 1)
		.flatMap((m) =>
			m.role === "tool"
				? m.content.flatMap((p) =>
						p.type === "tool-result" && p.output.type === "json" ? [p.output.value as Output] : [],
					)
				: [],
		);
}
const systemText = (prompt: Prompt) => prompt.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n");
/**
 * The system prompt's reply that starts with `start`, quoted whole: its sentence, or with `line` the rest of its line.
 * Null when the prompt has none.
 */
function quote(prompt: Prompt, start: string, line = false) {
	const system = systemText(prompt);
	const at = system.indexOf(start);
	if (at < 0) return null;
	const rest = system.slice(at);
	return say((line ? rest.split("\n")[0]! : /^[^.]*\./.exec(rest)![0]).trim());
}

const SETUP =
	/\b(?:where (?:am i|are we|do we stand) in (?:setting up|setup|set-up)|setup status|how far (?:along )?(?:is|are) (?:our )?setup)\b/i;
const FINISH = /\bfinish(?:ing)?\s+(?:setting\s+up|setup|the setup)\b/i;
const JOURNEY: [RegExp, unknown][] = [
	[/\bjust (?:getting )?start(?:ing|ed)\b|\bstill discerning\b/i, { answer: "discerning" }],
	[/\bnot sure (?:yet )?(?:where|what phase)\b/i, { answer: "unsure" }],
	[/\bskip (?:the )?(?:where (?:we|you) are|phase) (?:question|step)\b/i, { answer: "skip" }],
];
const EXISTING = /\bwe(?:'re| are) (?:already )?in phase ([0-6])\b/i;
const LEAD: [RegExp, unknown][] = [
	[/\bskip (?:the )?lead(?:er)? question\b/i, { answer: "skip" }],
	[/\bsomeone else leads\b|\bi(?:'m| am) not the lead\b/i, { answer: "no" }],
	[/\bi(?:'m| am) the (lead pastor|pastor|lead|leader)\b|\bi lead (?:it|the church|our church)\b/i, { answer: "yes" }],
];
const NEW_CHURCH = /\b(?:set up|start|create)\s+a\s+(?:new\s+)?church\s+called\s+(.+?)[.!]?\s*$/i;
const CONVERT = /\b(?:turn|convert|make)\s+my\s+discovery\s+space\s+into\s+a\s+church(?:\s+called\s+(.+?))?[.!]?\s*$/i;
const EXPLORE = /\b(?:explore first|just (?:want to )?explore|discovery space for me|set up a discovery space)\b/i;
const PROFILE = /\bwhat(?:'s| is) in my discovery space\b|\bmy discovery space\b\??\s*$/i;
const CHURCH_RECORDS = /\b(?:people|person|meetings?|teams?|ministr(?:y|ies)|tasks?|households?|messages?)\b/i;

/** The setup steps as the user reads them: saved steps with their answers, then the open ones. */
function stepsText(out: Output) {
	const rows = out.rows ?? [];
	const saved = rows.filter((r) => r.fields.status === "saved").map((r) => `${r.label} (${String(r.fields.answer)})`);
	const open = rows.filter((r) => r.fields.status !== "saved").map((r) => r.label);
	const church = String(out.facts?.church ?? "your church");
	return [
		`Setup of ${church}: you are in ${String(out.facts?.phase)}.`,
		saved.length ? `Saved: ${saved.join(", ")}.` : "Nothing is saved yet.",
		open.length ? `Still open: ${open.join(", ")}.` : "Every step is saved.",
	].join(" ");
}

/** One step of a setup or Discovery request, or null when it is none. */
export function onboardingStep(options: LanguageModelV4CallOptions, text: string): LanguageModelV4Content[] | null {
	const tools = JSON.stringify(options.tools ?? []);
	const offers = (operation: string) => tools.includes(`"${operation}"`);
	const outputs = turnOutputs(options.prompt);
	const last = outputs.at(-1);
	// A prepared review: the settings step answers it (the card is the answer).
	if (last && typeof last.proposalId === "string") return null;
	const resume = outputs.findLast((o) => o.operation === "onboarding.getResume");
	const profile = outputs.findLast((o) => o.operation === "discovery.getProfile");
	const account = /\bContext: account\b/.test(systemText(options.prompt));
	const setupRule = () => quote(options.prompt, "Only the Owner who is setting up");
	const readResume = () => call("onboarding_read", { operation: "onboarding.getResume", input: {} });
	const stepOf = (key: string) => resume?.rows?.find((r) => r.id.endsWith(`:${key}`));
	const noSetup = () =>
		say((resume?.exclusions as string[] | undefined)?.[0] ?? "This church has no setup in progress for you.");

	const journey = EXISTING.exec(text)
		? { answer: "existing", phase: Number(EXISTING.exec(text)![1]) }
		: JOURNEY.find(([r]) => r.test(text))?.[1];
	const lead = LEAD.find(([r]) => r.test(text));
	const known = SETUP.test(text) || FINISH.test(text) || journey || lead || NEW_CHURCH.test(text) || CONVERT.test(text);
	if (!known && !EXPLORE.test(text) && !PROFILE.test(text) && !(account && CHURCH_RECORDS.test(text))) return null;
	if (last?.error) return say(`I couldn't prepare that (${String(last.error)}).`);

	// An account with no church seat: start a church, explore first, or read and convert its Discovery space.
	if (account) {
		const convert = CONVERT.exec(text);
		if (convert && offers("discovery.convertToPlant")) {
			if (!convert[1]) return say("What should the church be called?");
			return propose("discovery.convertToPlant", { name: convert[1].trim() });
		}
		const named = NEW_CHURCH.exec(text);
		if (named && offers("onboarding.createPlant")) return propose("onboarding.createPlant", { name: named[1]!.trim() });
		if (PROFILE.test(text) && offers("discovery.getProfile")) {
			if (!profile) return call("onboarding_read", { operation: "discovery.getProfile", input: {} });
			if (profile.status !== "available")
				return say("You have no Discovery space yet. I can set one up for you to explore first.");
			const linked = (profile.rows ?? []).map((r) => `${r.label} (${String(r.fields.relationship)})`);
			return say(
				[
					`Your Discovery space: you have read ${String(profile.facts?.foundationsRead)} of ${String(profile.facts?.foundationsTotal)} foundation articles.`,
					linked.length ? `Linked: ${linked.join(", ")}.` : "No sending church or network is linked yet.",
				].join(" "),
			);
		}
		if (EXPLORE.test(text) && offers("discovery.create")) return propose("discovery.create", {});
		if (CHURCH_RECORDS.test(text)) return quote(options.prompt, "People, meetings, teams, tasks", true);
		return null;
	}

	// A church seat: its setup. Asking to start or convert a church again finds the church this account already holds.
	if (NEW_CHURCH.test(text) || CONVERT.test(text)) {
		if (!offers("onboarding.getResume"))
			return say("You already have a church seat, so there is no new church to start.");
		if (!resume) return readResume();
		const church = String(resume.facts?.church ?? "your church");
		return say(
			`You already have a church in Everyfield, ${church}, so I won't start another. Ask me where you are in setup.`,
		);
	}
	if (SETUP.test(text)) {
		if (!offers("onboarding.getResume")) return setupRule();
		if (!resume) return readResume();
		return resume.status === "available" ? say(stepsText(resume)) : noSetup();
	}
	if (FINISH.test(text)) {
		if (!offers("onboarding.complete")) return setupRule();
		if (!resume) return readResume();
		if (resume.status !== "available") return noSetup();
		if (stepOf("finish")?.fields.status === "saved")
			return say(`Setup of ${String(resume.facts?.church)} is already finished, so there is nothing to finish again.`);
		return propose("onboarding.complete", {});
	}
	if (lead) {
		if (!offers("identity.answerLeadOnboarding")) return setupRule();
		if (!resume) return readResume();
		if (resume.status !== "available") return noSetup();
		if (
			stepOf("team")?.fields.answer === "You hold the lead role" ||
			/Senior pastor/.test(String(stepOf("team")?.fields.answer))
		)
			return say(
				"A lead role is already assigned to you, so the lead question can't be answered again. Change it from your ministry teams.",
			);
		const answer = lead[1] as { answer: string };
		return propose(
			"identity.answerLeadOnboarding",
			answer.answer === "yes" && /\blead pastor\b/i.test(text) ? { answer: "yes", roleName: "Lead pastor" } : answer,
		);
	}
	if (journey) {
		if (!offers("onboarding.declareJourney")) return setupRule();
		if (!resume) return readResume();
		if (resume.status !== "available") return noSetup();
		const where = stepOf("journey");
		if (/^Declared /.test(String(where?.fields.answer)))
			return say(
				`Where you are is already saved: ${String(where!.fields.answer)} To move the church to another phase, record a phase change with a reason.`,
			);
		return propose("onboarding.declareJourney", { journey });
	}
	return null;
}
