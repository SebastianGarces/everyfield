import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";

// The scripted model's email conversations (T-322), for local previews and tests only: the asks a planter makes about
// email, answered through the same Communication reads and reviewed writes a qualified model uses. It never sends: a
// send, resend, retry, delete or template change is only ever proposed, and a chat "ok" is answered with where approval
// happens. Every fact it says comes from a tool result in this turn.

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { kind: string; id: string; label: string; fields: Record<string, unknown> };
type Result = { operation?: string; status?: string; rows?: Row[]; proposalId?: string; error?: unknown };

const text = (value: string): LanguageModelV4Content[] => [{ type: "text", text: value }];
const call = (toolName: string, input: unknown): LanguageModelV4Content => ({
	type: "tool-call",
	toolCallId: randomUUID(),
	toolName,
	input: JSON.stringify(input),
});
const read = (operation: string, input: unknown) => [call("communication_read", { operation, input })];
const propose = (operation: string, input: unknown) => [call("propose_change", { operation, input })];

/** Whether the turn's propose tool offers `domain`'s reviewed writes: a Member proposes only their own notification changes. */
export const proposesOn = (options: LanguageModelV4CallOptions, domain: string) =>
	JSON.stringify(options.tools?.find((t) => t.name === "propose_change") ?? {}).includes(`"${domain}.`);

/** Every user message, oldest first. */
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
/** The tool results since the last user message, oldest first: what this turn has read so far. */
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
const people = (n: number) => (n === 1 ? "1 person" : `${n} people`);

const INVITE = /\bdraft an email inviting all our prospects to (?:the )?vision night\b/i;
const LEFT_OUT: Record<string, string> = {
	no_address: "no email address",
	unsubscribed: "unsubscribed from this church's email",
	duplicate_address: "the same address as someone who gets it, so it goes once",
	blocked: "the address is blocked after a bounce",
};
/** The vision night invitation, from the meeting the audience read found. */
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

/** The preview read of the draft before the meeting is known. */
function previewDraft() {
	const { subject, body } = invitation(undefined);
	return read("communication.preview", {
		subject,
		body,
		audience: { groups: ["prospects"] },
		meetingWords: "vision night",
	});
}

/** One step of an email conversation, or null when the ask is not one of these. */
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

	// A Member may read Messages but never send or change it.
	if (!canPropose && /\b(send|resend|delete|email (them|everyone|all))\b/i.test(ask))
		return text("Sending or changing email needs an Owner or Admin of this church. Ask one of them to do it.");

	// COM-01: an unsaved draft, with exactly who it reaches and who is left out. Nothing is saved or sent.
	if (INVITE.test(ask)) {
		if (!last) return previewDraft();
		const draft = invitation(rowsOf(last, "meeting")[0]);
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
				`It would reach ${people(gets.length)}: ${list(gets)}.`,
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

	// COM-02: the draft above goes to one exact review. A chat "ok" is never the approval.
	if (/^\s*(ok|okay|yes|yep|sure)[.!]?\s*$/i.test(ask) && INVITE.test(earlier))
		return text("Nothing has been sent. Approval happens only on the review card: press Approve there to send it.");
	if (/^\s*(ok |okay )?send it\b(?! again)/i.test(ask) && INVITE.test(earlier)) {
		if (!canPropose) return null;
		if (!last) return previewDraft();
		if (last.proposalId)
			return text("Here's the exact email and who gets it. Nothing is sent until you press Approve.");
		const meeting = rowsOf(last, "meeting")[0];
		const draft = invitation(meeting);
		return propose("communication.sendReviewed", {
			subject: draft.subject,
			body: draft.body,
			audience: { groups: ["prospects"] },
			...(meeting ? { meetingId: meeting.id } : {}),
		});
	}

	// "did you send it?": the latest email and what the email service has reported, never more.
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
				`"${message.label}" was handed to the email service, but it hasn't answered for ${people(checking)} yet, so I can't say it was sent. The result is still being checked.`,
			);
		return text(
			[
				`Yes, "${message.label}" was sent${message.fields.sentAt ? ` (${String(message.fields.sentAt)})` : ""}.`,
				delivered
					? `Delivery is confirmed for ${people(delivered)}${pending ? `, not yet for ${people(pending)}` : ""}.`
					: "Delivery isn't confirmed yet for anyone. Messages shows it once the email service reports it.",
			].join(" "),
		);
	}

	// COM-03: one person's last email, asking which person first when the name matches more than one.
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
			return read("communication.forPerson", { personId: found[0]!.id });
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

	// GST-04 (email half): emails sent to a household, apart from any call recorded. An email is never a call.
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

	// COM-06: the people no email has gone out to, and how that was checked.
	if (/\bwho hasn['’]?t heard from us\b/i.test(ask)) {
		if (!last) return read("communication.forPerson", {});
		const names = rowsOf(last, "person").map((p) => p.label);
		return text(
			names.length
				? `${people(names.length)} have no email recorded: ${list(names)}. I checked every live person against Messages history for an email that went out. Calls, texts, visits and email sent outside Everyfield aren't in that check.`
				: "Every live person has had an email from Messages. Calls, texts and visits aren't in that check.",
		);
	}

	// COM-07: the templates by name, system or church; a system template is copied before it is edited.
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
		const draft = invitation(rowsOf(last, "meeting")[0]);
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
		const wanted = (editTemplate ?? copyTemplate)![1]!.toLowerCase();
		const found = rowsOf(last, "template").find((t) => t.label.toLowerCase() === wanted);
		if (!found) return text(`I can't find a template named ${(editTemplate ?? copyTemplate)![1]}.`);
		if (copyTemplate) {
			if (found.fields.origin !== "system") return text(`${found.label} is already the church's own template.`);
			return canPropose ? propose("communication.templates.fork", { sourceKey: found.fields.sourceKey }) : null;
		}
		if (found.fields.origin === "system")
			return text(
				`${found.label} is a system template, so it can't be edited. Want me to copy it into a church template first? Then you can change the copy.`,
			);
		return canPropose
			? propose("communication.templates.update", { templateId: found.id, subject: editTemplate![2] })
			: null;
	}

	// COM-009: a resend to delivered non-openers, only 24 hours after the send.
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
		const message = rowsOf(last, "message")[0]!;
		if (message.fields.tooSoon)
			return text(
				`A resend has to wait until 24 hours after the send. "${message.label}" can be resent from ${String(message.fields.resendFrom)}.`,
			);
		if (!rowsOf(last, "person").some((p) => p.fields.leftOut === null))
			return text("Nobody can get a resend: no one has a confirmed delivery without an open.");
		return canPropose ? propose("communication.executeResend", { communicationId: message.id }) : null;
	}

	// "send it again": never while a result is still being checked; a certain failure gets its own review.
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

	// Deleting a saved draft goes through its own review.
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
