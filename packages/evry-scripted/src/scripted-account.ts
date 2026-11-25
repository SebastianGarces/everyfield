import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { captured } from "@everyfield/evry";
import { call, propose, refusedText, say, turnOf, type Content, type Row } from "./scripted-turn.ts";

const LIST = /\bwhat documents do i have\b|\blist my documents\b/i;
const READ = /\bwhat does my (.+?) document say\b/i;
const ARCHIVE = /\barchive my (.+?) document\b/i;
const linked = (row: Row) => `[${row.label}](${String(row.fields.link)})`;

export function accountTurn(options: LanguageModelV4CallOptions, text: string): Content | null {
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
