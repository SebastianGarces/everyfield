import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { captured } from "@everyfield/evry";
import { call, propose, refusedText, say, turnOf, type Content, type Row } from "./scripted-turn.ts";

const LIST = /\bwhat documents do i have\b|\blist my documents\b/i;
const READ = /\bwhat does my (.+?) document say\b/i;
const ARCHIVE = /\barchive my (.+?) document\b/i;
const linked = (row: Row) => `[${row.label}](${String(row.fields.link)})`;

const TEMPLATES = /\b(?:which|what) templates\b/i;
const HOLDS = /\bwhat (?:does|is in) the (.+?) template(?: hold)?\b/i;
const START = /\b(?:start|make) (?:a|my) document from (?:the |our |my )?(.+?) template\b/i;
const PUT = /\bin my (.+?) document, put (.+?) as the (.+?)[.?!]?$/i;
const ASK = /\bfill in the blanks in my (.+?) document\b/i;
const BLANK = /\[[^\]\n]+\]|^[^\n:]{1,40}: _{4,}/gm;

const matching = (rows: Row[], asked: string) => {
	const words = asked.toLowerCase().split(/\s+/).filter(Boolean);
	return rows.find((row) => words.every((w) => `${row.label} ${row.id}`.toLowerCase().includes(w)));
};
const titles = (rows: Row[]) => rows.map((row) => row.label).join(", ");
const unavailable = (asked: string, rows: Row[]) =>
	say(
		`The ${asked} template isn't available in Discovery, so I prepared nothing. You can start from: ${titles(rows)}.`,
	);

function unique(text: string, needle: string) {
	const out: string[] = [];
	for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
		let [from, to] = [i, i + needle.length];
		const once = () => text.indexOf(text.slice(from, to)) === text.lastIndexOf(text.slice(from, to));
		while (!once() && (from > 0 || to < text.length)) {
			if (from > 0 && text[from - 1] !== "\n") from--;
			else if (to < text.length && text[to] !== "\n") to++;
			else if (from > 0) from--;
			else to++;
		}
		out.push(text.slice(from, to));
	}
	return out;
}

function templateTurn(options: LanguageModelV4CallOptions, text: string): Content | null {
	const { offers, last, of } = turnOf(options);
	const holds = HOLDS.exec(text);
	const start = START.exec(text);
	if (!holds && !start && !TEMPLATES.test(text)) return null;
	if (!offers("documents.createMineFromTemplate")) return null;
	if (last && typeof last.proposalId === "string")
		return say("I prepared a review. Nothing is saved until you approve it.");
	if (last?.error) return say(refusedText(last));
	const listed = of("documents.templates.list");
	if (!listed) return call("documents_read", { operation: "documents.templates.list", input: {} });
	const rows = listed.rows ?? [];
	const asked = holds ?? start;
	if (!asked) {
		const formal = rows.filter((row) => row.fields.class === "formal/legal").map((row) => row.label);
		return say(
			[
				`You can start a document of your own from these ${rows.length} templates:`,
				"",
				...rows.map((row) => `- ${row.label}: ${String(row.fields.about)}`),
				"",
				...(formal.length ? [`${formal.join(", ")} is a formal/legal template.`] : []),
				"A template is starting text you edit, not legal advice.",
			].join("\n"),
		);
	}
	const found = matching(rows, captured(asked, 1));
	if (!found) return unavailable(captured(asked, 1), rows);
	if (start) return propose("documents.createMineFromTemplate", { templateId: found.id });
	const got = of("documents.templates.get");
	if (!got) return call("documents_read", { operation: "documents.templates.get", input: { templateId: found.id } });
	const [template, ...blanks] = got.rows ?? [];
	if (!template) return unavailable(captured(asked, 1), rows);
	const name = template.fields.yourName;
	return say(
		[
			`${template.label}: ${String(template.fields.about)}`,
			`Sections: ${String(template.fields.sections)}.`,
			typeof name === "string" ? `Your name, ${name}, is filled in.` : "It doesn't fill in your name.",
			`Left blank for you to fill in: ${blanks.map((b) => b.label).join(", ")}.`,
			...(typeof template.fields.notice === "string"
				? [`It is a formal/legal template and starts with "${template.fields.notice}".`]
				: []),
		].join("\n"),
	);
}

function fillTurn(options: LanguageModelV4CallOptions, text: string): Content | null {
	const { offers, last, of } = turnOf(options);
	const put = PUT.exec(text);
	const ask = ASK.exec(text);
	const asked = put ?? ask;
	if (!asked || !offers("documents.createMineFromTemplate")) return null;
	if (last && typeof last.proposalId === "string")
		return say("I prepared a review. Nothing is saved until you approve it.");
	if (last?.error) return say(refusedText(last));
	const listed = of("documents.listOwned");
	if (!listed)
		return call("documents_read", { operation: "documents.listOwned", input: { title: captured(asked, 1) } });
	const [doc] = listed.rows ?? [];
	if (!doc) return say(`I can't find ${captured(asked, 1)} in your documents.`);
	const opened = of("documents.read");
	if (!opened) return call("documents_read", { operation: "documents.read", input: { documentId: doc.id } });
	const body = String(opened.rows?.[0]?.fields.text ?? "");
	if (!put) {
		const left = [...new Set(body.match(BLANK) ?? [])];
		return say(
			left.length
				? `${linked(doc)} still has these blanks: ${left.join(", ")}. Tell me what goes in each one and I'll prepare the change. I won't fill one in without your value.`
				: `${linked(doc)} has no blanks left.`,
		);
	}
	const blank = `[${captured(put, 3).toLowerCase()}]`;
	const found = unique(body, blank);
	if (!found.length) return say(`${linked(doc)} has no ${blank} blank.`);
	const value = captured(put, 2);
	return propose("documents.saveNative", {
		kind: "edit",
		documentId: doc.id,
		edits: found.map((find) => ({ find, replace: find.replace(blank, value) })),
	});
}

export function accountTurn(options: LanguageModelV4CallOptions, text: string): Content | null {
	const template = templateTurn(options, text) ?? fillTurn(options, text);
	if (template) return template;
	const { offers, last, of } = turnOf(options);
	const named = READ.exec(text) ?? ARCHIVE.exec(text);
	if (!named && !LIST.test(text)) return null;
	if (!offers("discovery.getProfile") || !offers("documents.listOwned")) return null;
	if (last && typeof last.proposalId === "string")
		return say("I prepared a review. Nothing changes until you approve it.");
	if (last?.error) return say(refusedText(last));
	const listed = of("documents.listOwned");
	if (!listed)
		return call("documents_read", {
			operation: "documents.listOwned",
			input: named ? { title: captured(named, 1) } : {},
		});
	const rows = listed.rows ?? [];
	if (!named)
		return say(
			rows.length
				? `Your documents:\n\n${rows.map((row) => `- ${linked(row)}`).join("\n")}`
				: "You have no documents yet.",
		);
	const [found] = rows;
	if (!found) return say(`I can't find ${captured(named, 1)} in your documents.`);
	if (ARCHIVE.test(text)) return propose("documents.archive", { documentId: found.id });
	const opened = of("documents.read");
	if (!opened) return call("documents_read", { operation: "documents.read", input: { documentId: found.id } });
	const [row] = opened.rows ?? [];
	return say(row ? `${linked(row)} says: "${String(row.fields.text)}"` : "I can't open that document.");
}
