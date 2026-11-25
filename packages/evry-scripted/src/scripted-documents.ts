import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { counted } from "@everyfield/contracts/common";
import { captured } from "@everyfield/evry";
import { call, propose, refusedText, say, turnOf, type Content, type Row } from "./scripted-turn.ts";

const LETTER = [
	"# Welcome to the launch team",
	"We are glad you said yes to helping start this church.",
	"## What to expect",
	"- Team night every other Thursday",
	"- A ministry to serve in",
	"Reply to this letter with any question.",
].join("\n\n");
const DRAFT = /\b(?:write|draft)\s+(?:us\s+)?an?\s+([\w -]*welcome letter)\b/i;
const EDIT = /\bin\s+(?:the|our)\s+(.+?),\s+change\s+"/i;
const WORDS = /"([^"]+)"\s+to\s+"([^"]*)"/g;
const FIT = /\btemplates?\s+(?:fit|fits|are there|do you have)\b/i;
const SHOW = /\bshow\s+(?:me\s+)?the\s+([a-z0-9-]+)\s+template\b/i;
const FILL = /\b(fill in|preview|make (?:a|the) file from)\s+the\s+([a-z0-9-]+)\s+template\b/i;
const VALUE = /\b([a-z_]+)\s*=\s*"([^"]*)"/g;
const LIST = /\b(?:what|which)\s+files\s+(?:have\s+we|did\s+we)\s+(?:made|make)\b/i;
const FILE = /\b(open|download)\s+the\s+(.+?)\s+file\b/i;
const CATEGORY: [RegExp, string][] = [
	[/\bvision meetings?\b/i, "vision_meeting"],
	[/\bcommitment\b/i, "commitment"],
	[/\badministrative\b/i, "administrative"],
	[/\boperational\b/i, "operational"],
];

export function documentTurn(options: LanguageModelV4CallOptions, text: string): Content | null {
	const { offers, last, of } = turnOf(options);
	const draft = DRAFT.exec(text);
	const edit = EDIT.exec(text);
	const show = SHOW.exec(text);
	const fill = FILL.exec(text);
	const file = FILE.exec(text);
	const fit = FIT.test(text);
	const list = LIST.test(text);
	if (!draft && !edit && !show && !fill && !file && !fit && !list) return null;
	if (!offers("documents.listOwned")) return null;
	if (last && typeof last.proposalId === "string")
		return say(
			typeof last.refusal === "string" ? last.refusal : "I prepared a review. Nothing changes until you approve it.",
		);
	if (last?.error) return say(refusedText(last));

	if (draft || edit) {
		if (!offers("documents.saveNative"))
			return say("Only an Owner or Admin of this church can write or change its documents.");
		if (draft)
			return propose("documents.saveNative", { kind: "new", title: "Launch team welcome letter", text: LETTER });
		if (!edit) return null;
		const listed = of("documents.listOwned");
		if (!listed)
			return call("documents_read", { operation: "documents.listOwned", input: { title: captured(edit, 1) } });
		const [found] = listed.rows ?? [];
		if (!found) return say(`I can't find ${captured(edit, 1)} in your documents.`);
		if (!of("documents.read"))
			return call("documents_read", { operation: "documents.read", input: { documentId: found.id } });
		return propose("documents.saveNative", {
			kind: "edit",
			documentId: found.id,
			edits: [...text.matchAll(WORDS)].map((m) => ({ find: captured(m, 1), replace: captured(m, 2) })),
		});
	}

	if (fit) {
		const result = of("documents.templates.contextual");
		if (!result) {
			const phase = /\bphase\s+(\d)\b/i.exec(text)?.[1];
			const article = /\barticle\s+([a-z0-9-/]+)/i.exec(text)?.[1];
			const category = CATEGORY.find(([pattern]) => pattern.test(text))?.[1];
			return call("documents_read", {
				operation: "documents.templates.contextual",
				input: {
					...(phase && { phase: Number(phase) }),
					...(article && { wikiSlug: article }),
					...(category && { category }),
				},
			});
		}
		const rows = result.rows ?? [];
		return say(
			rows.length
				? `${counted(rows.length, "template fits", "templates fit")}: ${rows.map((r) => `${r.label} (${r.id})`).join(", ")}.`
				: "No library template fits that.",
		);
	}

	if (show) {
		const result = of("documents.templates.get");
		if (!result)
			return call("documents_read", {
				operation: "documents.templates.get",
				input: { templateId: captured(show, 1) },
			});
		const [template, ...fields] = result.rows ?? [];
		return say(
			template
				? `${template.label} is made as ${String(template.fields.formats)}. Fields: ${fields.map((f) => `${f.label}${f.fields.required ? " (required)" : ""}`).join(", ") || "none"}.`
				: "That template is not in the library.",
		);
	}

	if (fill) {
		const input = {
			templateId: captured(fill, 2),
			values: [...text.matchAll(VALUE)].map((m) => ({ key: captured(m, 1), value: captured(m, 2) })),
		};
		const make = captured(fill, 1).toLowerCase().startsWith("make");
		const operation = captured(fill, 1).toLowerCase() === "fill in" ? "documents.resolveContext" : "documents.preview";
		const result = of(operation);
		if (!result) return call("documents_read", { operation, input });
		const fields = (result.rows ?? []).slice(1);
		const missing = result.facts?.missing;
		if (typeof missing === "string") return say(`Still needed: ${missing}. What should I put there?`);
		if (result.facts?.rendered === false) return say("The preview could not be made, so there is no file to make.");
		if (make) return propose("documents.generate", input);
		const filled = fields.map(
			(f: Row) => `${f.label}: ${String(f.fields.value ?? "blank")} (${String(f.fields.from)})`,
		);
		return say(
			`${filled.join("; ")}.${operation === "documents.preview" ? " This is a preview: nothing is saved." : ""}`,
		);
	}

	const listed = of("documents.history.list");
	if (!listed)
		return call("documents_read", {
			operation: "documents.history.list",
			input: file ? { title: captured(file, 2) } : {},
		});
	const rows = listed.rows ?? [];
	if (list)
		return say(
			rows.length
				? `${counted(rows.length, "file")}: ${rows.map((r) => `${r.label} (${String(r.fields.format)}, ${String(r.fields.state)})`).join(", ")}.`
				: "No file has been made yet.",
		);
	const [found] = rows;
	if (!file || !found) return say("I can't find a ready file by that name, so there is no link to give.");
	const operation = captured(file, 1).toLowerCase() === "open" ? "documents.history.get" : "documents.download";
	const result = of(operation);
	if (!result) return call("documents_read", { operation, input: { fileId: found.id } });
	const [one] = result.rows ?? [];
	if (!one) return say("That file is not available.");
	return say(
		operation === "documents.download"
			? `Here it is: [Download ${one.label}](${String(one.fields.href)}).`
			: `${one.label} is a ${String(one.fields.format)} file, ready, made ${String(one.fields.madeAt).slice(0, 10)}.`,
	);
}
