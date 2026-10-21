import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4Content,
	LanguageModelV4GenerateResult,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";

// A deterministic stand-in for a qualified model, for local previews and tests only (selectQualifiedModel never picks
// it on Vercel). It reads the conversation the way a model would see it and answers through the same tools, so the
// runtime, its limits, fences and stream are exercised end to end without a paid provider. It is not policy: the
// runtime enforces the boundary and limits whatever the model says.

type Prompt = LanguageModelV4CallOptions["prompt"];
const lastUserText = (prompt: Prompt) => {
	for (let i = prompt.length - 1; i >= 0; i--) {
		const m = prompt[i]!;
		if (m.role === "user")
			return m.content
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join(" ");
	}
	return "";
};
const lastToolOutput = (prompt: Prompt): Record<string, unknown> | null => {
	const m = prompt.at(-1);
	if (m?.role !== "tool") return null;
	const part = m.content.findLast((p) => p.type === "tool-result");
	if (!part || part.type !== "tool-result") return null;
	if (part.output.type === "json") return part.output.value as Record<string, unknown>;
	return part.output.type === "text" ? { text: part.output.value } : { error: part.output.type };
};
const toolCall = (toolName: string, input: unknown): LanguageModelV4Content => ({
	type: "tool-call",
	toolCallId: randomUUID(),
	toolName,
	input: JSON.stringify(input),
});

const pageSize = (text: string) =>
	Number(/\b(\d{1,3}) at a time\b/.exec(text)?.[1] ?? (/\bevery|all\b/i.test(text) ? 100 : 24));

function classify(text: string) {
	if (/\b(pray|prayer|biblical|scripture|spiritual(ly)?|pastoral(ly)?|suitab)/i.test(text)) return "pastoral_boundary";
	if (/what can you (do|help)|capabilit/i.test(text)) return "capabilities";
	return "application";
}

function respond(options: LanguageModelV4CallOptions): LanguageModelV4Content[] {
	const text = lastUserText(options.prompt);
	if (options.responseFormat?.type === "json")
		return [{ type: "text", text: JSON.stringify({ kind: classify(text) }) }];
	const hasPeople = options.tools?.some((t) => t.name === "people_read") ?? false;
	const canPropose = options.tools?.some((t) => t.name === "propose_change") ?? false;
	// "Change Maria's city to Austin": find the person, then propose the change for review.
	const change = /\b(?:change|set|update)\s+([A-Z][\w'-]+?)(?:'s)?\s+(city|phone|email)\s+to\s+(.+?)\.?\s*$/i.exec(
		text,
	);
	const result = lastToolOutput(options.prompt);
	if (result) {
		if (result.error) return [{ type: "text", text: `I could not finish that read (${String(result.error)}).` }];
		if (typeof result.proposalId === "string") {
			const [target] = result.rows as {
				label: string;
				fields: { changes: { field: string; before: unknown; after: unknown }[] };
			}[];
			if (!target) return [{ type: "text", text: "I prepared a change, but its source is no longer available." }];
			const changes = target.fields.changes.map(
				(c) => `${c.field} from ${String(c.before ?? "empty")} to ${String(c.after ?? "empty")}`,
			);
			return [
				{
					type: "text",
					text: `I prepared a change for ${target.label}: ${changes.join(", ")}. Nothing changes until you approve it.`,
				},
			];
		}
		const rows = (result.rows as { id: string; label: string; fields: { city: string | null } }[] | undefined) ?? [];
		if (change && canPropose && rows.length === 1)
			return [
				toolCall("propose_change", {
					operation: "people.updatePerson",
					input: { personId: rows[0]!.id, patch: { [change[2]!.toLowerCase()]: change[3] } },
				}),
			];
		// "every" asks for all pages: keep reading while the result says more exist; the runtime's budget stops it.
		if (/\bevery\b/i.test(text) && typeof result.next === "number")
			return [
				toolCall("people_read", {
					operation: "people.listPeople",
					input: { page: result.next, limit: pageSize(text) },
				}),
			];
		if (result.status === "not_found") return [{ type: "text", text: "I can't find that person in this church." }];
		const names = rows.map((r) => (r.fields.city ? `${r.label} (${r.fields.city})` : r.label));
		if ((/\bwhich\b|\bfind\b/i.test(text) || change) && rows.length > 1)
			return [{ type: "text", text: `I found ${rows.length} matches: ${names.join(", ")}. Which one do you mean?` }];
		const more = result.completeness === "partial" ? ` More exist; ask for page ${String(result.next)}.` : "";
		return [
			{ type: "text", text: `${String(result.total)} matched. Showing ${rows.length}: ${names.join(", ")}.${more}` },
		];
	}
	if (hasPeople) {
		const id = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(text)?.[1];
		if (id) return [toolCall("people_read", { operation: "people.getPerson", input: { personId: id } })];
		const name = change?.[1] ?? /\b(?:[Ff]ind|named|called|for)\s+([A-Z][\w'-]+)/.exec(text)?.[1];
		if (name) return [toolCall("people_read", { operation: "people.listPeople", input: { search: name } })];
		if (/\bpeople|everyone|members?\b/i.test(text))
			return [toolCall("people_read", { operation: "people.listPeople", input: { limit: pageSize(text) } })];
	}
	return [{ type: "text", text: "Ask me about the people in this church, for example: find Alex." }];
}

const usage = (options: LanguageModelV4CallOptions, content: LanguageModelV4Content[]) => {
	const input = Math.ceil(JSON.stringify(options.prompt).length / 4);
	const output = Math.ceil(JSON.stringify(content).length / 4);
	return {
		inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: output, text: output, reasoning: 0 },
	};
};

export function scriptedModel(): LanguageModelV4 {
	const generate = async (options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> => {
		const content = respond(options);
		return {
			content,
			finishReason: { unified: content.some((c) => c.type === "tool-call") ? "tool-calls" : "stop", raw: undefined },
			usage: usage(options, content),
			warnings: [],
		};
	};
	return {
		specificationVersion: "v4",
		provider: "evry",
		modelId: "scripted",
		supportedUrls: {},
		doGenerate: generate,
		async doStream(options) {
			const result = await generate(options);
			const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
			for (const c of result.content)
				if (c.type === "text") {
					const id = randomUUID();
					parts.push({ type: "text-start", id });
					// Word-sized deltas, so a reader sees the reply arrive in pieces as a provider would send it.
					for (const word of c.text.match(/\S+\s*/g) ?? []) parts.push({ type: "text-delta", id, delta: word });
					parts.push({ type: "text-end", id });
				} else if (c.type === "tool-call") parts.push(c);
			parts.push({ type: "finish", finishReason: result.finishReason, usage: result.usage });
			return {
				stream: new ReadableStream({
					async start(controller) {
						for (const part of parts) {
							if (options.abortSignal?.aborted) break;
							controller.enqueue(part);
							if (part.type === "text-delta") await new Promise((r) => setTimeout(r, 10));
						}
						controller.close();
					},
				}),
			};
		},
	};
}
