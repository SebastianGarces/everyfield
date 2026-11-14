import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { ZONE_NAME } from "../catalog/labels.ts";

// The scripted model's seat, Settings, sharing, connection, account and organization requests (T-327), for local
// previews and tests only. It answers through the same tools a model gets: a read, then a proposed change the user
// reviews. Sign-in, password and email changes and deleting the church are never tools, and a change no tool offers
// names who can make it: it answers both with the product's own replies from the system prompt (compile.ts), so the
// evals test the text the real model is given, not text written here.

type Prompt = LanguageModelV4CallOptions["prompt"];
type Output = Record<string, unknown> & { rows?: Row[] };
type Row = { id: string; label: string; fields: Record<string, unknown> };

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
/** The assistant's last text before the current user message. */
function lastAssistantText(prompt: Prompt) {
	const start = prompt.findLastIndex((m) => m.role === "user");
	for (let i = start - 1; i >= 0; i--) {
		const m = prompt[i]!;
		if (m.role === "assistant")
			return m.content
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join(" ");
	}
	return "";
}
const systemText = (prompt: Prompt) => prompt.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n");

/** The system prompt's reply for a Settings-only request (compile.ts SETTINGS_ONLY), or null when the prompt has none. */
function settingsOnly(prompt: Prompt, request: string) {
	const line = systemText(prompt)
		.split("\n")
		.find((l) => l.startsWith(`- ${request}: `));
	return line ? say(line.slice(request.length + 4)) : null;
}
/** The system prompt's role rule (compile.ts roleRule): who can make a change no tool offers. */
function notOffered(prompt: Prompt) {
	const rule = /Only an Owner or Admin can [^.]+\./.exec(systemText(prompt))?.[0];
	return rule ? say(`${rule} Ask one of them to make this change.`) : null;
}
/** A time zone by its everyday name, lowercased ("eastern" → America/New_York). */
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
/** What a review of these changes is about (proposals/review.ts targetKind). */
const TARGETS = new Set(["church", "seat", "invitation", "connection", "organization", "account"]);
/** The requests this step answers; anything else is left to the other scripted steps. */
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
/** The church digest schedule a request asks for, or null when it asks for one Settings doesn't offer. */
function churchDigest(text: string) {
	if (/\b(?:turn off|stop|pause)\b/i.test(text) || /\bdigest\s+off\b/i.test(text)) return { cadence: "off" };
	const at = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i.exec(text);
	if (!at || (at[2] && at[2] !== "00") || /\bevery\s+\d+\s+hours?\b|\bhourly\b/i.test(text)) return null;
	const twelve = Number(at[1]);
	if (twelve < 1 || twelve > 12) return null;
	const hour = (twelve % 12) + (at[3]!.toLowerCase() === "p" ? 12 : 0);
	if (/\b(?:every day|daily)\b/i.test(text)) return { cadence: "daily", hour };
	const day = new RegExp(String.raw`\bon\s+(${WEEKDAY.join("|")})s?\b`, "i").exec(text);
	return day ? { cadence: "weekly", weekday: WEEKDAY.indexOf(day[1]!.toLowerCase()), hour } : null;
}
const EMAIL = String.raw`([^\s@]+@[^\s@]+\.[A-Za-z]{2,})`;
const NAME = String.raw`([A-Z][\w'-]+(?: [A-Z][\w'-]+)?)`;

/** One step of a seat, Settings, sharing, connection, account or organization request, or null when it is none. */
export function settingsStep(options: LanguageModelV4CallOptions, text: string): LanguageModelV4Content[] | null {
	const tools = JSON.stringify(options.tools ?? []);
	const offers = (operation: string) => tools.includes(`"${operation}"`);
	const outputs = turnOutputs(options.prompt);
	const last = outputs.at(-1);
	const of = (operation: string) => outputs.findLast((o) => o.operation === operation);
	const rows = (operation: string) => of(operation)?.rows ?? [];
	// A prepared review of one of these changes: the card is the answer.
	if (last && typeof last.proposalId === "string")
		return TARGETS.has(String((last.rows?.[0] as { kind?: unknown } | undefined)?.kind))
			? say("I prepared a review. Nothing changes until you approve it.")
			: null;
	if (!REQUESTS.some((r) => r.test(text)) && lastAssistantText(options.prompt) !== NETWORK_QUESTION) return null;

	// Never tools: sign-in, password and email changes, and deleting the church.
	if (/\b(?:change|reset|update)\s+(?:my\s+)?password\b/i.test(text))
		return settingsOnly(options.prompt, "Change password");
	if (/\b(?:change|update)\s+my\s+(?:sign[- ]?in\s+|login\s+)?email\b/i.test(text))
		return settingsOnly(options.prompt, "Change sign-in email");
	if (/\bdelete\s+(?:our|the|this|my)\s+church\b/i.test(text)) return settingsOnly(options.prompt, "Delete the church");
	if (last?.error) return say(`I couldn't prepare that (${String(last.error)}).`);

	// Who has access: the seats, then the pending invitations an Owner or Admin may see.
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

	// Inviting someone to a seat.
	const invite = new RegExp(String.raw`\binvite\s+${EMAIL}\s+(?:as|to be)\s+(?:an?\s+)?(admin|member)\b`, "i").exec(
		text,
	);
	if (invite) {
		if (!offers("seats.invite")) return notOffered(options.prompt);
		return propose("seats.invite", { email: invite[1]!.toLowerCase(), role: invite[2]!.toLowerCase() });
	}

	// Resending or revoking a pending invitation, found by its address.
	const pending = new RegExp(
		String.raw`\b(resend|revoke|cancel|withdraw)\s+(?:the\s+)?invitation\s+(?:to|for)\s+${EMAIL}`,
		"i",
	).exec(text);
	if (pending) {
		const resend = pending[1]!.toLowerCase() === "resend";
		const operation = resend ? "seats.resendInvitation" : "seats.revokeInvitation";
		if (!offers(operation)) return notOffered(options.prompt);
		if (!of("seats.listInvitations")) return call("seats_read", { operation: "seats.listInvitations", input: {} });
		const found = rows("seats.listInvitations").find((r) => r.label.toLowerCase() === pending[2]!.toLowerCase());
		if (!found) return say(`No invitation to ${pending[2]} is waiting.`);
		return propose(operation, { invitationId: found.id });
	}

	// Changing a seat's role or removing a seat, found by the person's name.
	const role =
		new RegExp(String.raw`\b[Mm]ake\s+${NAME}\s+(?:an?\s+)?([Aa]dmin|[Mm]ember)\b`).exec(text) ??
		new RegExp(String.raw`\bchange\s+${NAME}'s\s+role\s+to\s+(admin|member)\b`, "i").exec(text);
	const removal = new RegExp(String.raw`\b[Rr]emove\s+${NAME}(?:'s seat|\s+from\s+(?:our|the|this)\s+church)\b`).exec(
		text,
	);
	if (role || removal) {
		const operation = role ? "seats.changeOrdinaryRole" : "seats.remove";
		if (!offers(operation)) return notOffered(options.prompt);
		if (!of("seats.list")) return call("seats_read", { operation: "seats.list", input: {} });
		const name = (role ?? removal)![1]!.toLowerCase();
		const found = rows("seats.list").filter((r) => r.label.toLowerCase().startsWith(name));
		if (found.length !== 1) return say(`I can't find one seat for ${(role ?? removal)![1]}.`);
		return role
			? propose(operation, { seatId: found[0]!.id, role: role[2]!.toLowerCase() })
			: propose(operation, { seatId: found[0]!.id });
	}

	// The church-wide digest schedule: off, daily at a whole hour, or weekly on a day at a whole hour.
	if (/\bchurch digest\b/i.test(text)) {
		if (!offers("church.digestSchedule.set")) return notOffered(options.prompt);
		const schedule = churchDigest(text);
		return schedule ? propose("church.digestSchedule.set", { schedule }) : say(DIGEST_CHOICES);
	}

	// The church's time zone and profile.
	const zone = /\bchange\s+(?:our|the)\s+church(?:'s)?\s+time ?zone\s+to\s+(\w+)/i.exec(text);
	if (zone && offers("plant.setTimezone")) {
		const timeZone = ZONES[zone[1]!.toLowerCase()];
		return timeZone ? propose("plant.setTimezone", { timeZone }) : say(`Which time zone is ${zone[1]}?`);
	}
	const profile =
		/\bupdate\s+(?:our|the)\s+church'?s\s+(name|street|city|state|province|country|description)\s+to\s+(.+?)\.?\s*$/i.exec(
			text,
		);
	if (profile && offers("plant.updateProfile"))
		return propose("plant.updateProfile", {
			patch: { [PROFILE_FIELD[profile[1]!.toLowerCase()]!]: profile[2]!.trim() },
		});

	// What the church shares with a connected organization, changing it, and ending a connection.
	const sharing = /\bwhat (?:are|do) we shar(?:e|ing) with\s+(.+?)\s*\??$/i.exec(text);
	if (sharing && offers("privacy.getSharing")) {
		const organization = sharing[1]!.replace(/^the\s+/i, "");
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
	if ((change && offers("privacy.setSharing")) || (ending && offers("associations.end"))) {
		const named = (change ? change[3]! : ending![1]!).replace(/^the\s+/i, "");
		const organization = /^them$/i.test(named) ? undefined : named;
		if (!of("privacy.getSharing"))
			return call("sharing_read", { operation: "privacy.getSharing", input: organization ? { organization } : {} });
		const found = rows("privacy.getSharing");
		if (found.length !== 1)
			return say(found.length ? "Which organization do you mean?" : "This church has no connection like that.");
		const organizationId = String(found[0]!.fields.organizationId);
		if (ending) return propose("associations.end", { organizationId });
		const category = CATEGORY.find(([pattern]) => pattern.test(change![2]!))?.[1];
		if (!category) return say(`Which category do you mean? You can share meetings, people totals, tasks and more.`);
		return propose("privacy.setSharing", { organizationId, category, enabled: change![1]!.toLowerCase() === "start" });
	}
	const connect = new RegExp(
		String.raw`\binvite\s+(.+?)\s+to\s+(?:be\s+)?(?:our\s+)?(?:sending church|network|connect)\b(?:.*?\bat\s+${EMAIL})?`,
		"i",
	).exec(text);
	if (connect && offers("associations.invite"))
		return propose("associations.invite", {
			organizationName: connect[1]!.trim(),
			...(connect[2] ? { recipientEmail: connect[2].toLowerCase() } : {}),
		});

	// The signed-in person's own photo and account.
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

	// An organization's own profile: ask for the new text when the request has none.
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
