import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { captured } from "./captured.ts";

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { kind?: string; id: string; label: string; fields: Record<string, unknown> };
type Output = Record<string, unknown> & { rows?: Row[]; facts?: Record<string, unknown> };

const call = (toolName: string, input: unknown): LanguageModelV4Content[] => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify(input) },
];
const say = (text: string): LanguageModelV4Content[] => [{ type: "text", text }];
const propose = (operation: string, input: unknown) => call("propose_change", { operation, input });

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
function quote(prompt: Prompt, start: string, line = false) {
	const system = systemText(prompt);
	const at = system.indexOf(start);
	if (at < 0) return null;
	const rest = system.slice(at);
	const quoted = line ? rest.split("\n")[0] : /^[^.]*\./.exec(rest)?.[0];
	return quoted === undefined ? null : say(quoted.trim());
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
const PRIVACY = /\bwhat (?:can|does) (.+?) see\b/i;
const OTHERS_SPACE = /\b(?!my\b)\w+'s discovery space\b/i;
const HISTORY = /\b(?:what happened to|where(?:'s| is)) my discovery space\b/i;
const CHURCH_RECORDS = /\b(?:people|person|meetings?|teams?|ministr(?:y|ies)|tasks?|households?|messages?)\b/i;

function stepsText(out: Output) {
	const rows = out.rows ?? [];
	const saved = rows.filter((r) => r.fields.status === "saved").map((r) => `${r.label} (${String(r.fields.answer)})`);
	const open = rows.filter((r) => r.fields.status !== "saved").map((r) => r.label);
	const church = String(out.facts?.church ?? "your church");
	return [
		`Setup of ${church}: you are in ${String(out.facts?.phase)}.`,
		saved.length ? `Saved: ${saved.join(", ")}.` : "Nothing is saved yet.",
		open.length ? `Still open: ${open.join(", ")}.` : "Every step is saved.",
		`Setup picks up at: ${String(out.facts?.resumeAt)}.`,
	].join(" ");
}

export function onboardingStep(options: LanguageModelV4CallOptions, text: string): LanguageModelV4Content[] | null {
	const tools = JSON.stringify(options.tools ?? []);
	const offers = (operation: string) => tools.includes(`"${operation}"`);
	const outputs = turnOutputs(options.prompt);
	const last = outputs.at(-1);
	if (last && typeof last.proposalId === "string") return null;
	const resume = outputs.findLast((o) => o.operation === "onboarding.getResume");
	const profile = outputs.findLast((o) => o.operation === "discovery.getProfile");
	const account = /\bContext: account\b/.test(systemText(options.prompt));
	const setupRule = () => quote(options.prompt, "Only the Owner who is setting up");
	const readResume = () => call("onboarding_read", { operation: "onboarding.getResume", input: {} });
	const stepOf = (key: string) => resume?.rows?.find((r) => r.id.endsWith(`:${key}`));
	const noSetup = () =>
		say((resume?.exclusions as string[] | undefined)?.[0] ?? "This church has no setup in progress for you.");

	const existing = EXISTING.exec(text);
	const journey = existing
		? { answer: "existing", phase: Number(existing[1]) }
		: JOURNEY.find(([r]) => r.test(text))?.[1];
	const lead = LEAD.find(([r]) => r.test(text));
	const known =
		SETUP.test(text) ||
		FINISH.test(text) ||
		journey ||
		lead ||
		NEW_CHURCH.test(text) ||
		CONVERT.test(text) ||
		HISTORY.test(text) ||
		OTHERS_SPACE.test(text);
	const accountAsk = account && (CHURCH_RECORDS.test(text) || PRIVACY.test(text));
	if (!known && !EXPLORE.test(text) && !PROFILE.test(text) && !accountAsk) return null;
	if (last?.error) return say(`I couldn't prepare that (${String(last.error)}).`);

	if (account) {
		const readProfile = () => call("onboarding_read", { operation: "discovery.getProfile", input: {} });
		if (OTHERS_SPACE.test(text)) return quote(options.prompt, "I can only work with your own setup", true);
		const convert = CONVERT.exec(text);
		if (convert && offers("discovery.convertToPlant")) {
			if (!profile) return readProfile();
			if (profile.status !== "available")
				return say("You have no Discovery space to turn into a church. I can start a new church for you instead.");
			if (!convert[1]) return say("What should the church be called?");
			return propose("discovery.convertToPlant", { name: convert[1].trim() });
		}
		const named = NEW_CHURCH.exec(text);
		if (named && offers("onboarding.createPlant"))
			return propose("onboarding.createPlant", { name: captured(named, 1).trim() });
		const privacy = PRIVACY.exec(text);
		if (privacy && offers("discovery.getProfile")) {
			if (!profile) return readProfile();
			const name = captured(privacy, 1).trim();
			const link = (profile.rows ?? []).find((r) => r.label.toLowerCase() === name.toLowerCase());
			if (!link) return say(`${name} is not linked to your Discovery space, so it sees nothing from it.`);
			const shares = link.fields.shares;
			return say(
				typeof shares === "string"
					? `${link.label} sees only what its link to your Discovery space shares: ${shares}. Nothing else from your account is shared.`
					: `${link.label} is linked to your Discovery space but its link shares nothing, so it sees nothing from your account.`,
			);
		}
		if (PROFILE.test(text) && offers("discovery.getProfile")) {
			if (!profile) return readProfile();
			if (profile.status !== "available")
				return offers("discovery.create")
					? [
							...say(
								"You have no Discovery space yet, so there is nothing to open. Here is one you can start to explore first.",
							),
							...propose("discovery.create", {}),
						]
					: say("You have no Discovery space yet.");
			const linked = (profile.rows ?? []).map((r) => `${r.label} (${String(r.fields.relationship)})`);
			return say(
				[
					`Your Discovery space: you have read ${String(profile.facts?.foundationsRead)} of ${String(profile.facts?.foundationsTotal)} foundation articles.`,
					linked.length ? `Linked: ${linked.join(", ")}.` : "No sending church or network is linked yet.",
				].join(" "),
			);
		}
		if (EXPLORE.test(text) && offers("discovery.create")) return propose("discovery.create", {});
		if (CHURCH_RECORDS.test(text)) return quote(options.prompt, "Finish setup first:", true);
		return null;
	}

	if (NEW_CHURCH.test(text) || CONVERT.test(text)) {
		if (!offers("onboarding.getResume"))
			return say("You already have a church seat, so there is no new church to start.");
		if (!resume) return readResume();
		const church = String(resume.facts?.church ?? "your church");
		return say(
			`You already have a church in Everyfield, ${church}, so I won't start another. Ask me where you are in setup.`,
		);
	}
	if (HISTORY.test(text)) {
		if (!offers("onboarding.getResume")) return setupRule();
		if (!resume) return readResume();
		const church = String(resume.facts?.church ?? "your church");
		const on = resume.facts?.discoveryClosedOn;
		return say(
			typeof on === "string"
				? `Your Discovery space closed on ${on}, when it became ${church}. Its links and sharing that carried over are now ${church}'s.`
				: `You have no Discovery space that became ${church}.`,
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
		if (!offers("identity.answerLeadOnboarding")) return quote(options.prompt, "Who leads this church");
		if (!resume) return readResume();
		if (resume.status !== "available") return noSetup();
		if (/^You hold the /.test(String(stepOf("team")?.fields.answer)))
			return say(
				"A lead role is already assigned to you, so the lead question can't be answered again. Change it from your ministry teams.",
			);
		return propose("identity.answerLeadOnboarding", lead[1]);
	}
	if (journey) {
		if (!offers("onboarding.declareJourney")) return setupRule();
		if (!resume) return readResume();
		if (resume.status !== "available") return noSetup();
		const where = stepOf("journey");
		if (where && /^Declared /.test(String(where.fields.answer)))
			return say(
				`Where you are is already saved: ${String(where.fields.answer)} To move the church to another phase, record a phase change with a reason.`,
			);
		return propose("onboarding.declareJourney", { journey });
	}
	return null;
}
