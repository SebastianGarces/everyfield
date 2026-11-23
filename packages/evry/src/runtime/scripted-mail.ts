import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { counted, weekdayOf } from "@everyfield/contracts/common";
import { present } from "./captured.ts";

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { kind: string; id: string; label: string; fields: Record<string, unknown> };
type Result = {
	operation?: string;
	status?: string;
	rows?: Row[];
	proposalId?: string;
	error?: unknown;
	problem?: unknown;
};

const text = (value: string): LanguageModelV4Content[] => [{ type: "text", text: value }];
const call = (toolName: string, input: unknown): LanguageModelV4Content => ({
	type: "tool-call",
	toolCallId: randomUUID(),
	toolName,
	input: JSON.stringify(input),
});
const read = (operation: string, input: unknown) => [call("communication_read", { operation, input })];
const propose = (operation: string, input: unknown) => [call("propose_change", { operation, input })];

export const proposesOn = (options: LanguageModelV4CallOptions, domain: string) =>
	JSON.stringify(options.tools?.find((t) => t.name === "propose_change") ?? {}).includes(`"${domain}.`);

function userTexts(prompt: Prompt) {
	return prompt
		.filter((m) => m.role === "user")
		.map((m) =>
			m.content
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join(" "),
		);
}
function turnResults(prompt: Prompt): Result[] {
	const last = prompt.findLastIndex((m) => m.role === "user");
	return prompt
		.slice(last + 1)
		.flatMap((m) =>
			m.role !== "tool"
				? []
				: m.content.flatMap((p) =>
						p.type === "tool-result" && p.output.type === "json" ? [p.output.value as Result] : [],
					),
		);
}
const rowsOf = (r: Result | undefined, kind: string) => (r?.rows ?? []).filter((x) => x.kind === kind);
const list = (names: string[]) =>
	names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const INVITE = /\bdraft an email inviting all our prospects to (?:the )?vision night\b/i;
const LEFT_OUT: Record<string, string> = {
	no_address: "no email address",
	unsubscribed: "unsubscribed from this church's email",
	duplicate_address: "the same address as someone who gets it, so it goes once",
	blocked: "the address is blocked after a bounce",
};
const thursdays = (meetings: Row[]) => meetings.find((m) => /^Thu\b/.test(String(m.fields.startsAt))) ?? meetings[0];
function invitation(meeting: Row | undefined) {
	const when = meeting ? String(meeting.fields.startsAt) : "Thursday";
	const title = meeting?.label ?? "Vision Night";
	return {
		title,
		when,
		subject: `You're invited: ${title}`,
		body: `Hi {{name}},\n\nYou're invited to ${title} on ${when}. Come hear where our church is headed, meet the team and bring your questions.\n\nWe'd love to see you there.`,
	};
}

function previewDraft() {
	const { subject, body } = invitation(undefined);
	return read("communication.preview", {
		subject,
		body,
		audience: { groups: ["prospects"] },
		meetingWords: "vision night",
	});
}

const reads = (options: LanguageModelV4CallOptions, operation: string) =>
	JSON.stringify(options.tools?.find((t) => t.name === "communication_read") ?? {}).includes(`"${operation}"`);
const OWNER_ONLY = (what: string) => `Only an Owner or Admin of this church can ${what}. Ask one of them.`;
const RESULT_TEXT: Record<string, string> = {
	waiting: "waiting for its send time",
	checking: "still being checked: the email service hasn't answered, so it may or may not have gone",
	sent: "sent, but delivery isn't confirmed yet",
	delivered: "delivered, no open recorded",
	opened: "delivered and opened",
	bounced: "bounced",
	failed: "failed: the email service refused it",
	cancelled: "cancelled",
	unsubscribed: "not sent: they unsubscribed from this church's email",
};
const OPEN_TEXT =
	"An open is only what the email service's tracking saw: it misses some opens and counts some automatic ones, and it doesn't mean anyone read it or will come.";
const CAN_EMAIL: Record<string, string> = {
	can_email: "can get email",
	no_address: "has no email address, so they can't get email",
	unsubscribed: "unsubscribed from this church's email",
};
const OUTCOME_WORDS: [RegExp, string][] = [
	[/\b(no answer|voicemail|didn['’]?t pick up|no one picked up)\b/i, "attempted_no_contact"],
	[/\b(talked|spoke|reached)\b/i, "contacted"],
];
const weekday = (at: unknown) =>
	typeof at === "string" && /^\d{4}-\d{2}-\d{2}/.test(at)
		? ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][weekdayOf(at.slice(0, 10))]
		: null;
const errorOf = (r: Result | undefined) => (typeof r?.error === "string" ? r.error : null);

function newMailStep(options: LanguageModelV4CallOptions, ask: string, earlier: string, results: Result[]) {
	const last = results.at(-1);
	const canPropose = proposesOn(options, "communication");

	const about = /\bwhat emails have we sent about (.+?)\??\s*$/i.exec(ask);
	if (about) {
		if (!last)
			return read("communication.forMeeting", { meetingWords: present(about[1]).replace(/^\w+day['’]s\s+/i, "") });
		const meeting = rowsOf(last, "meeting")[0];
		if (!meeting) return text(`I can't find a meeting matching ${about[1]}.`);
		const emails = rowsOf(last, "message");
		const when = (m: Row) =>
			m.fields.sentAt
				? `sent ${String(m.fields.sentAt)}`
				: m.fields.scheduledFor
					? `scheduled for ${String(m.fields.scheduledFor)}`
					: "not sent";
		return text(
			emails.length
				? [
						`Emails about ${meeting.label} (${String(meeting.fields.startsAt)}):`,
						...emails.map((m) => `- "${m.label}": ${String(m.fields.state)}, ${when(m)}`),
						"",
						"A sent email isn't a confirmed delivery. Ask who got it to see each person's result.",
					].join("\n")
				: `Messages has no email about ${meeting.label} (${String(meeting.fields.startsAt)}).`,
		);
	}

	const invited = /\bwho got the (.+?) invitation\b/i.exec(ask);
	if (invited) {
		if (!last) return read("communication.meetingRecipientTracking", { meetingWords: present(invited[1]) });
		const meeting = rowsOf(last, "meeting")[0];
		if (!meeting) return text(`I can't find a meeting matching ${invited[1]}.`);
		const people = rowsOf(last, "person");
		if (!people.length) return text(`No email about ${meeting.label} has gone to anyone yet.`);
		return text(
			[
				`The emails about ${meeting.label} went to ${counted(people.length, "person", "people")}:`,
				...people.map((p) => {
					const result = String(p.fields.result);
					const at =
						result === "opened" && p.fields.openedAt
							? ` (opened ${String(p.fields.openedAt)})`
							: result === "delivered" && p.fields.deliveredAt
								? ` (${String(p.fields.deliveredAt)})`
								: "";
					return `- ${p.label}: ${RESULT_TEXT[result] ?? result}${at}`;
				}),
				"",
				OPEN_TEXT,
			].join("\n"),
		);
	}

	if (/\bhow did (?:my|our) last email do\b/i.test(ask)) {
		if (!last) return read("communication.deliveryTotals", {});
		const t = rowsOf(last, "tally")[0];
		if (!t) return text("I can't find an email that went out from Messages.");
		const f = t.fields;
		return text(
			[
				`"${t.label}"${f.sentAt ? ` (sent ${String(f.sentAt)})` : ""}, as of ${String(f.asOf)}:`,
				`- Sent (accepted by the email service): ${String(f.sent)} of ${String(f.recipients)}`,
				`- Delivered: ${String(f.delivered)}${Number(f.deliveryNotConfirmed) > 0 ? ` (delivery not confirmed yet for ${String(f.deliveryNotConfirmed)})` : ""}`,
				`- Opened: ${String(f.opened)}`,
				`- Bounced: ${String(f.bounced)}`,
				`- Failed: ${String(f.failed)}`,
				`- Unsubscribed: ${String(f.unsubscribed)}`,
				`- Still being checked: ${String(f.stillChecking)}`,
				"",
				OPEN_TEXT,
			].join("\n"),
		);
	}

	if (/\bwhich teams can I (?:send|email)\b/i.test(ask)) {
		if (!reads(options, "communication.listAudienceTeams"))
			return text(OWNER_ONLY("choose the teams an email goes to"));
		if (!last) return read("communication.listAudienceTeams", {});
		const teams = rowsOf(last, "team").map((t) => t.label);
		return text(
			teams.length
				? `You can send an email to ${counted(teams.length, "team", "teams")}: ${list(teams)}.`
				: "This church has no team an email can go to yet.",
		);
	}

	const search =
		/^\s*can I email ([A-Z][\w'-]*(?: [A-Z][\w'-]*)?)\s*\??\s*$/i.exec(ask) ??
		/^\s*find ([A-Z][\w'-]*(?: [A-Z][\w'-]*)?) (?:so I can|to) email (?:them|him|her)\s*\??\s*$/i.exec(ask);
	if (search) {
		if (!reads(options, "communication.searchRecipients")) return text(OWNER_ONLY("search who can get email"));
		if (!last) return read("communication.searchRecipients", { query: present(search[1]) });
		const people = rowsOf(last, "person");
		if (!people.length) return text(`I can't find anyone named ${search[1]} in this church.`);
		return text(
			people.map((p) => `- ${p.label}: ${CAN_EMAIL[String(p.fields.email)] ?? String(p.fields.email)}`).join("\n"),
		);
	}

	if (/\bam I unsubscribed from everyfield emails?\b/i.test(ask)) {
		if (!reads(options, "mail.suppression.listForSelf")) return text("I can check this only for a seat in a church.");
		if (!last) return read("mail.suppression.listForSelf", {});
		if (errorOf(last)) return text("I can't check your email address right now. Try again in a moment.");
		const self = rowsOf(last, "setting")[0];
		if (!self) return text("Your account's email address isn't verified, so I can't check it.");
		const restores = rowsOf(last, "history").map(
			(r) =>
				`- Restored ${String(r.fields.at)}${r.fields.by ? ` by ${String(r.fields.by)}` : ""}: ${String(r.fields.reason)}`,
		);
		return text(
			[
				self.fields.blocked
					? "Yes. Your email address is blocked from Everyfield email, so nothing Everyfield sends reaches it. I can't clear the block: you can restore it yourself in Messages."
					: "No. Your email address isn't blocked from Everyfield email.",
				...(restores.length ? ["", "Earlier restores:", ...restores] : []),
			].join("\n"),
		);
	}

	const removeTemplate = /\b(delete|archive|remove) the (.+?) template\b/i.exec(ask);
	if (removeTemplate) {
		if (!canPropose) return text(OWNER_ONLY("remove an email template"));
		if (!last) return read("communication.templates.list", {});
		if (errorOf(last))
			return text(
				typeof last.problem === "string" ? last.problem : "I couldn't prepare that change. Nothing has changed.",
			);
		if (last.proposalId)
			return text("Here's the template change to review. Nothing changes until you press Approve on the card.");
		const wanted = present(removeTemplate[2]).toLowerCase();
		const found = rowsOf(last, "template").find((t) => t.label.toLowerCase() === wanted);
		if (!found) return text(`I can't find a template named ${removeTemplate[2]}.`);
		if (found.fields.origin === "system")
			return text(
				`${found.label} is a system template: it's part of Everyfield, so it can't be deleted or archived. Only the church's own templates can.`,
			);
		return propose("communication.templates.archiveOrDelete", { templateId: found.id });
	}

	const fix = /\bthe call with ([A-Z][\w'-]+) on (\w+day) was actually (.+?),? (?:please )?fix it\b/i.exec(ask);
	if (fix) {
		const [name, day, what] = [present(fix[1]), present(fix[2]), present(fix[3])];
		if (!last) return [call("people_read", { operation: "people.listPeople", input: { search: name } })];
		if (last.operation === "people.listPeople") {
			const found = rowsOf(last, "person");
			if (found.length !== 1)
				return text(
					found.length
						? `I found ${found.length}: ${list(found.map((p) => p.label))}. Which one do you mean?`
						: `I can't find ${name} in this church.`,
				);
			return [
				call("followups_read", {
					operation: "followups.listContactHistory",
					input: { personId: present(found[0]).id },
				}),
			];
		}
		if (last.operation === "followups.listContactHistory") {
			const entry = rowsOf(last, "contact").find(
				(c) => c.fields.state !== "superseded" && weekday(c.fields.occurredAt) === day.toLowerCase(),
			);
			if (!entry) return text(`I can't find a contact log entry for ${name} on ${day}.`);
			const outcome = OUTCOME_WORDS.find(([words]) => words.test(what))?.[1];
			if (!outcome) return text(`What should the entry say happened on that call?`);
			return propose("communication.correctContactLog", { outcomeId: entry.id, outcome, reason: ask });
		}
		const refused = errorOf(last);
		if (refused === "not_assigned" || refused === "access_denied")
			return text(
				"You can correct only a contact log entry you recorded on a follow-up you still own. Ask an Owner or Admin to correct this one.",
			);
		if (refused) return text("I couldn't prepare that correction. Nothing has changed.");
		return text(
			"Here's the correction to review. The old entry stays in the log as superseded. Nothing changes until you press Approve.",
		);
	}
	return null;
}

export function mailStep(options: LanguageModelV4CallOptions): LanguageModelV4Content[] | null {
	const tools = new Set(options.tools?.map((t) => t.name) ?? []);
	const canRead = tools.has("communication_read");
	const canPropose = proposesOn(options, "communication");
	const asks = userTexts(options.prompt);
	const ask = asks.at(-1) ?? "";
	const earlier = asks.slice(0, -1).join("\n");
	const results = turnResults(options.prompt);
	const last = results.at(-1);
	if (!canRead) return null;
	if (/^\s*(ok|okay|yes|yep|sure)[.!]?\s*$/i.test(ask) && /\b(template|fix it)\b/i.test(earlier))
		return text("Nothing has changed. Approval happens only on the review card: press Approve there.");
	const added = newMailStep(options, ask, earlier, results);
	if (added) return added;

	if (!canPropose && /\b(send|resend|delete|email (them|everyone|all))\b/i.test(ask))
		return text("Sending or changing email needs an Owner or Admin of this church. Ask one of them to do it.");

	if (INVITE.test(ask)) {
		if (!last) return previewDraft();
		const draft = invitation(thursdays(rowsOf(last, "meeting")));
		const persons = rowsOf(last, "person");
		const gets = persons.filter((p) => p.fields.leftOut === null).map((p) => p.label);
		const out = persons.filter((p) => p.fields.leftOut !== null);
		return text(
			[
				`Here's a draft for ${draft.title} (${draft.when}). It isn't saved or sent.`,
				"",
				`**Subject:** ${draft.subject}`,
				"",
				draft.body.replace("{{name}}", "[first name]"),
				"",
				`It would reach ${counted(gets.length, "person", "people")}: ${list(gets)}.`,
				...(out.length
					? [
							"",
							"Left out:",
							...out.map((p) => `- ${p.label}: ${LEFT_OUT[String(p.fields.leftOut)] ?? p.fields.leftOut}`),
						]
					: []),
				"",
				"Say send it when you're ready, and I'll show you the exact email to approve.",
			].join("\n"),
		);
	}

	if (/^\s*(ok|okay|yes|yep|sure)[.!]?\s*$/i.test(ask) && INVITE.test(earlier))
		return text("Nothing has been sent. Approval happens only on the review card: press Approve there to send it.");
	if (/^\s*(ok |okay )?send it\b(?! again)/i.test(ask) && INVITE.test(earlier)) {
		if (!canPropose) return null;
		if (!last) return previewDraft();
		if (last.proposalId)
			return text("Here's the exact email and who gets it. Nothing is sent until you press Approve.");
		const meeting = thursdays(rowsOf(last, "meeting"));
		const draft = invitation(meeting);
		return propose("communication.sendReviewed", {
			subject: draft.subject,
			body: draft.body,
			audience: { groups: ["prospects"] },
			...(meeting ? { meetingId: meeting.id } : {}),
		});
	}

	if (/\bdid you send it\b/i.test(ask)) {
		if (!last) return read("communication.get", {});
		const message = rowsOf(last, "message")[0];
		if (!message) return text("I can't find an email that went out from Messages.");
		const results = rowsOf(last, "person").map((p) => String(p.fields.result));
		const n = (r: string) => results.filter((x) => x === r).length;
		const delivered = n("delivered") + n("opened");
		const pending = n("sent");
		const checking = n("checking");
		if (!delivered && !pending && checking)
			return text(
				`"${message.label}" was handed to the email service, but it hasn't answered for ${counted(checking, "person", "people")} yet, so I can't say it was sent. The result is still being checked.`,
			);
		return text(
			[
				`Yes, "${message.label}" was sent${message.fields.sentAt ? ` (${String(message.fields.sentAt)})` : ""}.`,
				delivered
					? `Delivery is confirmed for ${counted(delivered, "person", "people")}${pending ? `, not yet for ${counted(pending, "person", "people")}` : ""}.`
					: "Delivery isn't confirmed yet for anyone. Messages shows it once the email service reports it.",
			].join(" "),
		);
	}

	const openAsk = /\bdid (\w+) open my last email\b/i;
	const opened =
		openAsk.exec(ask) ?? (openAsk.test(earlier) ? /^\s*([A-Z][\w'-]+(?: [A-Z][\w'-]+)?)\s*\.?\s*$/.exec(ask) : null);
	if (opened) {
		if (!last) return [call("people_read", { operation: "people.listPeople", input: { search: opened[1] } })];
		if (last.operation === "people.listPeople") {
			const found = rowsOf(last, "person");
			if (found.length > 1)
				return text(`I found ${found.length}: ${list(found.map((p) => p.label))}. Which one do you mean?`);
			if (!found.length) return text(`I can't find ${opened[1]} in this church.`);
			return read("communication.forPerson", { personId: present(found[0]).id });
		}
		const name = results[0]?.rows?.find((r) => r.kind === "person")?.label ?? opened[1] ?? "them";
		const email = rowsOf(last, "message")[0];
		if (!email) return text(`Messages has no email to ${name}.`);
		const result = String(email.fields.result);
		const fact =
			result === "opened"
				? `it was delivered, and an open was recorded ${String(email.fields.openedAt)}`
				: result === "delivered"
					? "it was delivered, and no open is recorded"
					: result === "sent"
						? "it was sent, and delivery isn't confirmed yet"
						: `its result is ${result}`;
		return text(
			`Your last email to ${name}, "${email.label}" (${String(email.fields.sentAt)}): ${fact}. An open is only what the email service's tracking saw. It doesn't mean ${name.split(" ")[0]} will come, or that anyone talked with them.`,
		);
	}

	const household = /\bdid anyone call the (\w+?)s? yet\b/i.exec(ask);
	if (household) {
		if (!last) return [call("people_read", { operation: "people.listPeople", input: { search: household[1] } })];
		if (last.operation === "people.listPeople")
			return rowsOf(last, "person").map((p) =>
				call("communication_read", { operation: "communication.forPerson", input: { personId: p.id } }),
			);
		const found = rowsOf(results[0], "person");
		const reads = results.slice(1);
		const lines = found.map((p, i) => {
			const emails = (reads[i]?.rows ?? [])
				.filter((r) => r.kind === "message")
				.map((r) => `"${r.label}" (${String(r.fields.sentAt)}, ${String(r.fields.result)})`);
			return `- ${p.label}: ${emails.length ? emails.join(", ") : "no email sent"}`;
		});
		return text(
			[
				"Emails sent to them from Messages:",
				...lines,
				"",
				"An email isn't a call, so none of these counts as one. Recorded calls aren't in Messages history, and no recorded call doesn't prove nobody called.",
			].join("\n"),
		);
	}

	if (/\bwho hasn['’]?t heard from us\b/i.test(ask)) {
		if (!last) return read("communication.forPerson", {});
		const names = rowsOf(last, "person").map((p) => p.label);
		return text(
			names.length
				? `${counted(names.length, "person", "people")} have no email recorded: ${list(names)}. I checked every live person against Messages history for an email that went out. Calls, texts, visits and email sent outside Everyfield aren't in that check.`
				: "Every live person has had an email from Messages. Calls, texts and visits aren't in that check.",
		);
	}

	if (/\bwhat email templates do we have\b/i.test(ask)) {
		if (!last) return read("communication.templates.list", {});
		const rows = rowsOf(last, "template");
		return text(
			[
				`You have ${rows.length} email templates:`,
				...rows.map((t) => `- ${t.label} (${t.fields.origin === "system" ? "system" : "church"})`),
				"",
				"System templates can't be edited, but I can copy one into a church template you can edit.",
			].join("\n"),
		);
	}
	if (/\bmake a template from this draft\b/i.test(ask) && INVITE.test(earlier)) {
		if (!canPropose) return null;
		if (!last) return previewDraft();
		if (last.proposalId) return text("Here's the template to review. Nothing is saved until you press Approve.");
		const draft = invitation(thursdays(rowsOf(last, "meeting")));
		return propose("communication.templates.create", {
			name: "Vision night invitation",
			category: "meeting_invitation",
			subject: draft.subject,
			body: draft.body,
		});
	}
	const editTemplate = /\bchange the subject of the (.+?) template to (.+?)\.?\s*$/i.exec(ask);
	const copyTemplate = /\bcopy the (.+?) template\b/i.exec(ask);
	if (editTemplate || copyTemplate) {
		if (!last) return read("communication.templates.list", {});
		if (last.proposalId) return text("Here's the change to review. Nothing changes until you press Approve.");
		const wanted = present(present(editTemplate ?? copyTemplate)[1]).toLowerCase();
		const found = rowsOf(last, "template").find((t) => t.label.toLowerCase() === wanted);
		if (!found) return text(`I can't find a template named ${present(editTemplate ?? copyTemplate)[1]}.`);
		if (copyTemplate) {
			if (found.fields.origin !== "system") return text(`${found.label} is already the church's own template.`);
			return canPropose ? propose("communication.templates.fork", { sourceKey: found.fields.sourceKey }) : null;
		}
		if (found.fields.origin === "system")
			return text(
				`${found.label} is a system template, so it can't be edited. Want me to copy it into a church template first? Then you can change the copy.`,
			);
		return canPropose
			? propose("communication.templates.update", { templateId: found.id, subject: present(editTemplate)[2] })
			: null;
	}

	const resendAsk = /\bresend (?:it|the (.+?) email) to the people who didn['’]?t open it\b/i.exec(ask);
	if (resendAsk) {
		if (!last) return read("communication.get", resendAsk[1] ? { subject: resendAsk[1] } : {});
		if (last.operation === "communication.get") {
			const message = rowsOf(last, "message")[0];
			if (!message) return text("I can't find an email that went out from Messages.");
			return read("communication.resendCandidates", { communicationId: message.id, selection: "delivered_nonopeners" });
		}
		if (last.proposalId)
			return text(
				"Here's who the resend goes to and who is left out. Open tracking isn't reliable, so some people who read it show no open. Nothing is sent until you press Approve.",
			);
		const message = present(rowsOf(last, "message")[0]);
		if (message.fields.tooSoon)
			return text(
				`A resend has to wait until 24 hours after the send. "${message.label}" can be resent from ${String(message.fields.resendFrom)}.`,
			);
		if (!rowsOf(last, "person").some((p) => p.fields.leftOut === null))
			return text("Nobody can get a resend: no one has a confirmed delivery without an open.");
		return canPropose ? propose("communication.executeResend", { communicationId: message.id }) : null;
	}

	const againAsk = /\bsend (?:it|the (.+?)) again\b/i.exec(ask);
	if (againAsk) {
		if (!last) return read("communication.get", againAsk[1] ? { subject: againAsk[1] } : {});
		if (last.proposalId)
			return text("Here's the retry, to the failed recipients only. Nothing is sent until you press Approve.");
		const message = rowsOf(last, "message")[0];
		if (!message) return text("I can't find an email that went out from Messages.");
		const results = rowsOf(last, "person").map((p) => String(p.fields.result));
		if (results.includes("checking"))
			return text(
				`The email service hasn't answered about "${message.label}" yet, so the result is still being checked. I won't send it again: that could send it twice.`,
			);
		if (!results.some((r) => r === "failed" || r === "bounced"))
			return text(`Nothing in "${message.label}" failed, so there's nothing to send again.`);
		return canPropose ? propose("communication.retryProvenFailed", { communicationId: message.id }) : null;
	}

	const remove = /\bdelete the (.+?) draft\b/i.exec(ask);
	if (remove) {
		if (!last) return read("communication.list", { state: "draft", subject: remove[1] });
		if (last.proposalId) return text("Here's the draft to delete. It stays until you press Approve.");
		const draft = rowsOf(last, "message")[0];
		if (!draft) return text(`I can't find a draft called ${remove[1]}.`);
		return canPropose ? propose("communication.deleteDraft", { communicationId: draft.id }) : null;
	}
	return null;
}
