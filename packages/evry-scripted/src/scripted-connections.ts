import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { counted } from "@everyfield/contracts/common";
import { captured } from "@everyfield/evry";
import { call, propose, refusedText, say, turnOf, type Content } from "./scripted-turn.ts";

const CHURCH = /\bwhat\s+(?:is|are)\s+our\s+(?:church\s+profile|inactivity\s+days|digest\s+schedule)\b/i;
const OWN = /\bwhat\s+is\s+my\s+account\s+name\b/i;
const ORGANIZATION = /\bwhat\s+is\s+our\s+(?:organization|network)'?s?\s+profile\b/i;
const RENAME = /\bchange\s+my\s+account\s+name\s+to\s+(.+?)\.?\s*$/i;
const INACTIVITY = /\bwarn\s+(?:us\s+)?after\s+(\d+)\s+days\b(?:.*?\balert\s+(?:us\s+)?after\s+(\d+)\s+days)?/i;
const PHOTO = /\b(show|remove)\s+my\s+(?:account\s+)?photo\b/i;
const PENDING = /\bwhich\s+link\s+invitations\s+are\s+(?:pending|waiting)\b/i;
const ACT = /\b(resend|withdraw|decline)\s+the\s+link\s+invitation\s+(?:to|from)\s+(.+?)\.?\s*$/i;
const PAST = /\bshow\s+(?:me\s+)?our\s+past\s+links\b/i;
const ACTS: Record<string, string> = {
	resend: "associations.resendInvitation",
	withdraw: "associations.revokeInvitation",
	decline: "associations.declineInvitation",
};
const ADMINS = "Only an Owner or Admin can do that.";

export function connectionStep(options: LanguageModelV4CallOptions, text: string): Content | null {
	const { offers, last, of } = turnOf(options);
	const rename = RENAME.exec(text);
	const inactivity = INACTIVITY.exec(text);
	const photo = PHOTO.exec(text);
	const act = ACT.exec(text);
	const asked = [CHURCH, OWN, ORGANIZATION, PENDING, PAST].some((p) => p.test(text));
	if (!asked && !rename && !inactivity && !photo && !act) return null;
	if (last && typeof last.proposalId === "string")
		return say(
			typeof last.refusal === "string" ? last.refusal : "I prepared a review. Nothing changes until you approve it.",
		);
	if (last?.error) return say(refusedText(last));

	if (rename) return propose("settings.saveSection", { section: "account", name: captured(rename, 1) });
	if (inactivity)
		return propose("settings.saveSection", {
			section: "church",
			warningDays: Number(captured(inactivity, 1)),
			...(inactivity[2] && { alertDays: Number(inactivity[2]) }),
		});
	if (photo && captured(photo, 1).toLowerCase() === "remove") return propose("account.removeAvatar", {});
	if (photo) {
		const shown = of("account.getAvatar");
		if (!shown) return call("settings_read", { operation: "account.getAvatar", input: {} });
		return say(
			shown.rows?.[0]?.fields.photo === "available" ? "Here is your account photo." : "You have no account photo.",
		);
	}

	if (CHURCH.test(text) || OWN.test(text)) {
		const section = OWN.test(text) ? "account" : "church";
		const found = of("settings.getSection");
		if (!found) return call("settings_read", { operation: "settings.getSection", input: { section } });
		if (!found.rows?.length) return say("Only an Owner or Admin can read the church's settings.");
		const [first] = found.rows;
		if (section === "account") return say(`Your account name is ${first?.label}.`);
		const at = (id: string) => found.rows?.find((r) => r.id === id)?.fields ?? {};
		const { warningDays, alertDays } = at("inactivity");
		return say(
			`${first?.label}, ${String(at("profile").city ?? "no city set")}. A warning comes after ${String(warningDays)} days and an alert after ${String(alertDays)}. The church digest goes out: ${String(at("digest").schedule)}.`,
		);
	}
	if (ORGANIZATION.test(text)) {
		if (!offers("organizations.getProfile")) return say("There is no organization profile for this seat.");
		const found = of("organizations.getProfile");
		if (!found) return call("settings_read", { operation: "organizations.getProfile", input: {} });
		const [profile] = found.rows ?? [];
		return say(profile ? `${profile.label}: ${String(profile.fields.description ?? "no description")}` : ADMINS);
	}
	if (PAST.test(text)) {
		const found = of("associations.getHistory");
		if (!found) return call("connections_read", { operation: "associations.getHistory", input: {} });
		const rows = found.rows ?? [];
		return say(
			rows.length
				? rows.map((r) => `${r.label}: ${String(r.fields.entry)} ${String(r.fields.on).slice(0, 10)}`).join("; ") + "."
				: "No link is recorded.",
		);
	}
	const operation = act && ACTS[captured(act, 1).toLowerCase()];
	if (operation && !offers(operation)) return say(ADMINS);
	const pending = of("associations.listInvitations");
	if (!pending) return call("connections_read", { operation: "associations.listInvitations", input: {} });
	const rows = pending.rows ?? [];
	if (!act || !operation)
		return say(
			rows.length
				? `${counted(rows.length, "link invitation is", "link invitations are")} pending: ${rows.map((r) => `${r.label} (${String(r.fields.direction)})`).join(", ")}.`
				: "No link invitation is pending.",
		);
	const name = captured(act, 2).toLowerCase();
	const found = rows.find((r) => r.label.toLowerCase() === name);
	return found
		? propose(operation, { invitationId: found.id })
		: say(`No pending link invitation with ${captured(act, 2)}.`);
}
