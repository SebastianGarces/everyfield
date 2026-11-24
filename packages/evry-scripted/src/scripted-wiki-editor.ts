import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { captured } from "@everyfield/evry";

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { kind?: string; id: string; label: string; fields: Record<string, unknown> };
type Output = Record<string, unknown> & { rows?: Row[] };

const call = (toolName: string, input: unknown): LanguageModelV4Content[] => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify(input) },
];
const say = (text: string): LanguageModelV4Content[] => [{ type: "text", text }];

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

const DRAFT =
	/\bdraft (?:our|my) own version of (?:the )?(.+?) article\b(?:.*?\badds? (?:our |my |the )?([a-z][a-z ]*?)(?::\s*(.+?))?)?[.!]?\s*$/i;
const CHANGE = /\bchange (?:our|my|the) (.+?) in (?:our |the )?(.+?) article to (.+?)[.!]?\s*$/i;
const PUBLISH = /\bpublish (?:our|my) version of (?:the )?(.+?) article\b/i;
const HIDE = /\bhide (?:our|my) version of (?:the )?(.+?) article\b/i;
const EDITOR_ONLY = /Only an Owner or Admin of your [^.]+ can edit its Wiki\. Nothing was prepared\./;

type Ask =
	| { kind: "add"; topic: string; label: string | undefined; details: string | undefined }
	| { kind: "edit"; topic: string; label: string; replaceWith: string }
	| { kind: "publish" | "hide"; topic: string };

function asked(text: string): Ask | null {
	const draft = DRAFT.exec(text);
	if (draft) return { kind: "add", topic: captured(draft, 1), label: draft[2]?.trim(), details: draft[3]?.trim() };
	const change = CHANGE.exec(text);
	if (change)
		return { kind: "edit", label: captured(change, 1), topic: captured(change, 2), replaceWith: captured(change, 3) };
	const publish = PUBLISH.exec(text);
	if (publish) return { kind: "publish", topic: captured(publish, 1) };
	const hide = HIDE.exec(text);
	return hide ? { kind: "hide", topic: captured(hide, 1) } : null;
}

const labelled = (label: string, details: string) => `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${details}`;

export function wikiEditorStep(options: LanguageModelV4CallOptions, text: string): LanguageModelV4Content[] | null {
	const system = systemText(options.prompt);
	if (!/Context: sending_(?:network|church)\./.test(system)) return null;
	const ask = asked(text);
	if (!ask) return null;
	const operation = `wiki.organizationArticles.${ask.kind}`;
	if (!JSON.stringify(options.tools ?? []).includes(`"${operation}"`)) {
		const rule = EDITOR_ONLY.exec(system)?.[0];
		return rule ? say(rule) : null;
	}
	const last = turnOutputs(options.prompt).at(-1);
	if (last?.error) return say(`I couldn't do that (${String(last.error)}). Nothing was prepared.`);
	if (typeof last?.proposalId === "string") {
		if (last.status === "refused") return say(`${String(last.refusal)} Nothing was prepared.`);
		const title = last.rows?.[0]?.label ?? "the article";
		if (ask.kind === "add")
			return say(
				`I prepared a review card for your own draft of ${title}: the Wiki's version with your text added at the end. Nothing is saved until you approve it, and churches keep seeing the Wiki's version until you publish it.`,
			);
		if (ask.kind === "edit")
			return say(
				`I prepared a review card that changes your ${ask.label} in your draft of ${title} to ${ask.replaceWith}. Nothing is saved until you approve it.`,
			);
		return say(
			ask.kind === "publish"
				? `I prepared a review card to publish your version of ${title}. Churches that share your Wiki see it once you approve.`
				: `I prepared a review card to hide your version of ${title}. Once you approve, churches no longer see it and can open the Wiki's standard version instead. Your version history is kept.`,
		);
	}
	const article = ask.topic;
	if (ask.kind === "add") {
		if (!ask.label || !ask.details)
			return say(
				`What should your version of the ${article} article add? Tell me the ${ask.label ?? "text"} word for word, such as a name and email, and I'll add exactly that. Nothing was prepared.`,
			);
		return call("propose_change", { operation, input: { article, text: labelled(ask.label, ask.details) } });
	}
	if (ask.kind === "edit")
		return call("propose_change", {
			operation,
			input: { article, about: ask.label, text: labelled(ask.label, ask.replaceWith) },
		});
	return call("propose_change", { operation, input: { article } });
}
