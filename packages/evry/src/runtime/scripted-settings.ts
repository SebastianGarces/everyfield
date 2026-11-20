import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { ZONE_NAME } from "../catalog/labels.ts";
import { captured } from "./captured.ts";

type Prompt = LanguageModelV4CallOptions["prompt"];
type Output = Record<string, unknown> & { rows?: Row[] };
type Row = { id: string; label: string; fields: Record<string, unknown> };

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
function lastAssistantText(prompt: Prompt) {
	const start = prompt.findLastIndex((m) => m.role === "user");
	const m = start < 0 ? undefined : prompt.slice(0, start).findLast((message) => message.role === "assistant");
	if (!m) return "";
	return m.content
		.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join(" ");
}
const systemText = (prompt: Prompt) => prompt.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n");

function settingsOnly(prompt: Prompt, request: string) {
	const line = systemText(prompt)
		.split("\n")
		.find((l) => l.startsWith(`- ${request}: `));
	return line ? say(line.slice(request.length + 4)) : null;
}
function notOffered(prompt: Prompt) {
	const rule = /Only an Owner or Admin can [^.]+\./.exec(systemText(prompt))?.[0];
	return rule ? say(`${rule} Ask one of them to make this change.`) : null;
}
const ZONES = Object.fromEntries(Object.entries(ZONE_NAME).map(([zone, name]) => [name.toLowerCase(), zone]));
const CATEGORY: [RegExp, string][] = [
	[/\bmeetings?\b/i, "meetings"],
	[/\bpeople\b/i, "people"],
	[/\btasks?\b/i, "tasks"],
	[/\b(?:ministry )?teams?\b/i, "ministry_teams"],
	[/\bwiki\b/i, "wiki"],
	[/\bactivity\b/i, "activity"],
	[/\bfindings?\b/i, "shared_findings"],
];
const PROFILE_FIELD: Record<string, string> = {
	name: "name",
	street: "street",
	city: "city",
	state: "stateProvince",
	province: "stateProvince",
	country: "country",
	description: "description",
};
const NETWORK_QUESTION = "What should the description say?";
const TARGETS = new Set(["church", "seat", "invitation", "connection", "organization", "account"]);
const REQUESTS = [
	/\bpassword\b/i,
	/\b(?:change|update)\s+my\s+(?:sign[- ]?in\s+|login\s+)?email\b/i,
	/\bdelete\s+(?:our|the|this|my)\s+(?:church|account|login)\b/i,
	/\bwho (?:has|holds) (?:access|(?:a )?seats?)\b/i,
	/\binvite\b/i,
	/\binvitation\b/i,
	/\bmake\s+[A-Z][\w'-]+.*\b(?:admin|member)\b/i,
	/\b(?:role|seat)\b/i,
	/\bremove\s+[A-Z][\w'-]+.*\bfrom\s+(?:our|the|this)\s+church\b/i,
	/\btime ?zone\b/i,
	/\bchurch digest\b/i,
	/\bchurch'?s\s+(?:name|street|city|state|province|country|description)\b/i,
	/\bshar(?:e|ing)\b/i,
	/\bconnection\b/i,
	/\bmy\s+(?:profile\s+)?(?:photo|picture)\b/i,
	/\bdescription\b/i,
];
const WEEKDAY = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DIGEST_CHOICES =
	"The church digest can be off, daily at a whole hour, or weekly on one day at a whole hour, in the church's time zone. Those are the only choices Settings offers.";
function churchDigest(text: string) {
	if (/\bturn off\b/i.test(text)) return { cadence: "off" };
	const at = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*([ap])m\b/i.exec(text);
	if (!at || (at[2] && at[2] !== "00")) return null;
	const hour = (Number(at[1]) % 12) + (captured(at, 3).toLowerCase() === "p" ? 12 : 0);
	if (/\bevery day\b/i.test(text)) return { cadence: "daily", hour };
	const day = new RegExp(String.raw`\bon\s+(${WEEKDAY.join("|")})s?\b`, "i").exec(text);
	return day ? { cadence: "weekly", weekday: WEEKDAY.indexOf(captured(day, 1).toLowerCase()), hour } : null;
}
const EMAIL = String.raw`([^\s@]+@[^\s@]+\.[A-Za-z]{2,})`;
const NAME = String.raw`([A-Z][\w'-]+(?: [A-Z][\w'-]+)?)`;

export function settingsStep(options: LanguageModelV4CallOptions, text: string): LanguageModelV4Content[] | null {
	const tools = JSON.stringify(options.tools ?? []);
	const offers = (operation: string) => tools.includes(`"${operation}"`);
	const outputs = turnOutputs(options.prompt);
	const last = outputs.at(-1);
	const of = (operation: string) => outputs.findLast((o) => o.operation === operation);
	const rows = (operation: string) => of(operation)?.rows ?? [];
	if (last && typeof last.proposalId === "string")
		return TARGETS.has(String((last.rows?.[0] as { kind?: unknown } | undefined)?.kind))
			? say("I prepared a review. Nothing changes until you approve it.")
			: null;
	if (!REQUESTS.some((r) => r.test(text)) && lastAssistantText(options.prompt) !== NETWORK_QUESTION) return null;

	if (/\b(?:change|reset|update)\s+(?:my\s+)?password\b/i.test(text))
		return settingsOnly(options.prompt, "Change password");
	if (/\b(?:change|update)\s+my\s+(?:sign[- ]?in\s+|login\s+)?email\b/i.test(text))
		return settingsOnly(options.prompt, "Change sign-in email");
	if (/\bdelete\s+(?:our|the|this|my)\s+church\b/i.test(text)) return settingsOnly(options.prompt, "Delete the church");
	if (last?.error) return say(`I couldn't prepare that (${String(last.error)}).`);

	if (/\bwho has access\b|\bwho (?:has|holds) (?:a )?seats?\b/i.test(text) && offers("seats.list")) {
		if (!of("seats.list")) return call("seats_read", { operation: "seats.list", input: {} });
		if (offers("seats.listInvitations") && !of("seats.listInvitations"))
			return call("seats_read", { operation: "seats.listInvitations", input: {} });
		const seats = rows("seats.list").map((r) => `${r.label} (${String(r.fields.role)}${r.fields.you ? ", you" : ""})`);
		const invitations = rows("seats.listInvitations").map((r) => `${r.label} as ${String(r.fields.role)}`);
		const waiting = !of("seats.listInvitations")
			? ""
			: invitations.length
				? ` ${invitations.length === 1 ? "1 invitation is" : `${invitations.length} invitations are`} waiting: ${invitations.join(", ")}.`
				: " No invitation is waiting.";
		return say(
			`${seats.length} ${seats.length === 1 ? "person has" : "people have"} access: ${seats.join(", ")}.${waiting}`,
		);
	}

	const invite = new RegExp(String.raw`\binvite\s+${EMAIL}\s+(?:as|to be)\s+(?:an?\s+)?(admin|member)\b`, "i").exec(
		text,
	);
	if (invite) {
		if (!offers("seats.invite")) return notOffered(options.prompt);
		return propose("seats.invite", {
			email: captured(invite, 1).toLowerCase(),
			role: captured(invite, 2).toLowerCase(),
		});
	}

	const pending = new RegExp(
		String.raw`\b(resend|revoke|cancel|withdraw)\s+(?:the\s+)?invitation\s+(?:to|for)\s+${EMAIL}`,
		"i",
	).exec(text);
	if (pending) {
		const resend = captured(pending, 1).toLowerCase() === "resend";
		const operation = resend ? "seats.resendInvitation" : "seats.revokeInvitation";
		if (!offers(operation)) return notOffered(options.prompt);
		if (!of("seats.listInvitations")) return call("seats_read", { operation: "seats.listInvitations", input: {} });
		const found = rows("seats.listInvitations").find(
			(r) => r.label.toLowerCase() === captured(pending, 2).toLowerCase(),
		);
		if (!found) return say(`No invitation to ${pending[2]} is waiting.`);
		return propose(operation, { invitationId: found.id });
	}

	const role =
		new RegExp(String.raw`\b[Mm]ake\s+${NAME}\s+(?:an?\s+)?([Aa]dmin|[Mm]ember)\b`).exec(text) ??
		new RegExp(String.raw`\bchange\s+${NAME}'s\s+role\s+to\s+(admin|member)\b`, "i").exec(text);
	const removal = new RegExp(String.raw`\b[Rr]emove\s+${NAME}(?:'s seat|\s+from\s+(?:our|the|this)\s+church)\b`).exec(
		text,
	);
	const seat = role ?? removal;
	if (seat) {
		const operation = role ? "seats.changeOrdinaryRole" : "seats.remove";
		if (!offers(operation)) return notOffered(options.prompt);
		if (!of("seats.list")) return call("seats_read", { operation: "seats.list", input: {} });
		const name = captured(seat, 1).toLowerCase();
		const found = rows("seats.list").filter((r) => r.label.toLowerCase().startsWith(name));
		const [one] = found;
		if (!one || found.length !== 1) return say(`I can't find one seat for ${captured(seat, 1)}.`);
		return role
			? propose(operation, { seatId: one.id, role: captured(role, 2).toLowerCase() })
			: propose(operation, { seatId: one.id });
	}

	if (/\bchurch digest\b/i.test(text)) {
		if (!offers("church.digestSchedule.set")) return notOffered(options.prompt);
		const schedule = churchDigest(text);
		return schedule ? propose("church.digestSchedule.set", { schedule }) : say(DIGEST_CHOICES);
	}

	const zone = /\bchange\s+(?:our|the)\s+church(?:'s)?\s+time ?zone\s+to\s+(\w+)/i.exec(text);
	if (zone && offers("plant.setTimezone")) {
		const timeZone = ZONES[captured(zone, 1).toLowerCase()];
		return timeZone ? propose("plant.setTimezone", { timeZone }) : say(`Which time zone is ${zone[1]}?`);
	}
	const profile =
		/\bupdate\s+(?:our|the)\s+church'?s\s+(name|street|city|state|province|country|description)\s+to\s+(.+?)\.?\s*$/i.exec(
			text,
		);
	const profileField = profile && PROFILE_FIELD[captured(profile, 1).toLowerCase()];
	if (profile && profileField && offers("plant.updateProfile"))
		return propose("plant.updateProfile", { patch: { [profileField]: captured(profile, 2).trim() } });

	const sharing = /\bwhat (?:are|do) we shar(?:e|ing) with\s+(.+?)\s*\??$/i.exec(text);
	if (sharing && offers("privacy.getSharing")) {
		const organization = captured(sharing, 1).replace(/^the\s+/i, "");
		if (!of("privacy.getSharing"))
			return call("sharing_read", { operation: "privacy.getSharing", input: { organization } });
		const [found] = rows("privacy.getSharing");
		if (!found) return say(`This church is not connected with ${organization}.`);
		const shared = String(found.fields.shared ?? "");
		if (!found.fields.shared) return say(`Owners and Admins choose what this church shares with ${found.label}.`);
		if (shared === "nothing") return say(`This church shares nothing with ${found.label} right now.`);
		const list = shared.split(", ");
		return say(
			`This church shares ${list.length === 1 ? "1 category" : `${list.length} categories`} with ${found.label}: ${list.join(" and ")}.`,
		);
	}
	const change = /\b(stop|start)\s+sharing\s+(.+?)\s+with\s+(them|.+?)\.?\s*$/i.exec(text);
	const ending = /\bend\s+(?:our|the)\s+connection\s+with\s+(.+?)\.?\s*$/i.exec(text);
	const target = change ? captured(change, 3) : ending ? captured(ending, 1) : null;
	if (target !== null && ((change && offers("privacy.setSharing")) || (ending && offers("associations.end")))) {
		const named = target.replace(/^the\s+/i, "");
		const organization = /^them$/i.test(named) ? undefined : named;
		if (!of("privacy.getSharing"))
			return call("sharing_read", { operation: "privacy.getSharing", input: organization ? { organization } : {} });
		const found = rows("privacy.getSharing");
		const [connection] = found;
		if (!connection || found.length !== 1)
			return say(found.length ? "Which organization do you mean?" : "This church has no connection like that.");
		const organizationId = String(connection.fields.organizationId);
		if (ending || !change) return propose("associations.end", { organizationId });
		const category = CATEGORY.find(([pattern]) => pattern.test(captured(change, 2)))?.[1];
		if (!category) return say(`Which category do you mean? You can share meetings, people totals, tasks and more.`);
		return propose("privacy.setSharing", {
			organizationId,
			category,
			enabled: captured(change, 1).toLowerCase() === "start",
		});
	}
	const connect = new RegExp(
		String.raw`\binvite\s+(.+?)\s+to\s+(?:be\s+)?(?:our\s+)?(?:sending church|network|connect)\b(?:.*?\bat\s+${EMAIL})?`,
		"i",
	).exec(text);
	if (connect && offers("associations.invite"))
		return propose("associations.invite", {
			organizationName: captured(connect, 1).trim(),
			...(connect[2] ? { recipientEmail: connect[2].toLowerCase() } : {}),
		});

	if (
		/\b(?:use|make|set)\s+(?:this|it)\s+(?:as\s+)?my\s+(?:profile\s+)?(?:photo|picture)\b/i.test(text) &&
		offers("account.finalizeAvatar")
	) {
		const uploadId = /"kind":"photo","id":"([0-9a-f-]{36})"/.exec(systemText(options.prompt))?.[1];
		return uploadId
			? propose("account.finalizeAvatar", { uploadId })
			: say("Attach a photo with the photo button first, then ask again.");
	}
	if (/\bdelete\s+my\s+(?:account|login)\b/i.test(text) && offers("account.requestDeletion"))
		return propose("account.requestDeletion", {});

	const network = /\bupdate\s+our\s+(?:network|organization|church)'?s\s+description(?:\s+to:?\s+(.+?))?\s*$/is.exec(
		text,
	);
	if (network && offers("organizations.updateProfile"))
		return network[1]
			? propose("organizations.updateProfile", { patch: { description: network[1].trim() } })
			: say(NETWORK_QUESTION);
	if (lastAssistantText(options.prompt) === NETWORK_QUESTION && offers("organizations.updateProfile"))
		return propose("organizations.updateProfile", { patch: { description: text.trim() } });
	return null;
}
