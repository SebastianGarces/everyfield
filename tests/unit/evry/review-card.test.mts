import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	mailReport,
	type MailReport,
	recipientOutcome,
} from "../../../packages/contracts/src/communication/results.ts";
import { mount, propsOf } from "./fake-dom.mts";

const { ReviewCard } = await import("../../../apps/web/src/features/evry/review/ReviewCard.tsx");
const { MAIL_CONSEQUENCE } = await import("../../../apps/web/src/features/evry/review/MailChanges.tsx");
const { LEFT_OUT_REASON, MAIL_DISMISSED, RECIPIENT_OUTCOME, stoppedReason } =
	await import("../../../apps/web/src/features/evry/review/model.ts");

const NOW = "2026-10-21T12:00:00Z";
const ID = "11111111-1111-4111-8111-111111111111";
type Change = { field: string; before: unknown; after: unknown };
const change = (field: string, after: unknown, before: unknown = null): Change => ({ field, before, after });
const reviewed = (operation: string, changes: Change[], over: Record<string, unknown> = {}) => ({
	id: ID,
	conversationId: "c",
	operation,
	revision: 1,
	digest: "d",
	expiresAt: "2026-10-21T12:10:00Z",
	approvedAt: null,
	status: "pending",
	review: { target: null, changes },
	outcome: null,
	executing: false,
	receipt: null,
	stale: false,
	now: NOW,
	...over,
});
const church = { changed: () => false, refused: () => false, leave() {}, reload() {} };
const card = (seed: ReturnType<typeof reviewed>) =>
	mount(ReviewCard, { proposalId: seed.id, target: null, seed, church });
async function shown(seed: ReturnType<typeof reviewed>) {
	const at = await card(seed);
	const seen = { text: at.text(), lines: at.lines() };
	await at.unmount();
	return seen;
}

const CANNED = {
	accepted: "Accepted does not mean the email arrived.",
	notDelivered: "Accepted does not mean delivered: Messages shows each delivery when the email service reports it.",
	consequence: "Accepted is not delivered: Messages shows each delivery when the email service reports it.",
};
const REPORTED_BY_SERVICE = "Already delivered";
const DEFERRED = ["Delivery not confirmed", "Sent, delivery not confirmed yet"];
const DELIVERY = /deliver|arriv|receiv|inbox|reached/i;
const claims = (text: string) =>
	[...Object.values(CANNED), ...DEFERRED].reduce((t, sentence) => t.replaceAll(sentence, ""), text).match(DELIVERY);

const SEND_AT = { at: "2026-10-23T20:00:00Z", zone: "America/Chicago" };
const audience = { groups: ["prospects"], teamIds: [ID], personIds: [ID], recipients: 2, noAddress: 1 };
const mailChanges = [
	change("subject", "Friday note"),
	change("sendAt", SEND_AT, SEND_AT),
	change("body", "Come along", "Come"),
	change("audience", audience, audience),
	change("recipientCount", 2),
	change("recipients", [{ name: "Ana Lee" }]),
	change(
		"leftOut",
		Object.keys(LEFT_OUT_REASON)
			.filter((reason) => reason !== "delivered")
			.map((reason) => ({ name: "Ben Cho", reason })),
	),
	change("content", "Come along"),
	change("meeting", { title: "Vision Night", ...SEND_AT, when: "Friday", venue: "Hall", isNew: true }),
	change("guests", [{ name: "Ana Lee" }, { name: "Ben Cho", note: "Already a guest" }]),
	change("draft", null, "Friday note"),
	change("template", "deleted", "Welcome"),
	change("usedBy", 2),
	change("name", "Welcome", "Hello"),
	change("category", "follow_up"),
	change("copyOf", "Welcome"),
];
const MAIL = [...Object.keys(MAIL_CONSEQUENCE), "evry.prepareMeetingInvitation", "evry.reuseRecipe"];
const OPERATION: Record<MailReport["kind"], string[]> = {
	schedule: ["communication.scheduleReviewed"],
	reschedule: ["communication.rescheduleReviewed"],
	cancel: ["communication.cancelScheduledReviewed"],
	replace: ["communication.replaceScheduledReviewed"],
	replace_stopped: ["communication.replaceScheduledReviewed"],
	send: [
		"communication.sendReviewed",
		"communication.executeResend",
		"communication.retryProvenFailed",
		"evry.prepareMeetingInvitation",
		"evry.reuseRecipe",
	],
};
const CODES = [
	undefined,
	"stale_review",
	"schedule_window_exceeded",
	"rsvp_needs_meeting",
	"mailing_address_missing",
	"access_denied",
	"provider_refused",
	"another_code",
];
const people = recipientOutcome.options.map((outcome) => ({ name: "Ana Lee", outcome }));

function reports(): MailReport[] {
	return mailReport.options.flatMap((option) => {
		const { kind, confirmation } = option.shape;
		return [...confirmation.options].flatMap((state) =>
			[0, 2].flatMap((n) =>
				CODES.flatMap((code) =>
					[undefined, 2].flatMap((waiting) => {
						const all: Record<string, unknown> = {
							kind: kind.value,
							confirmation: state,
							scheduledAt: SEND_AT.at,
							accepted: n,
							refused: n,
							unknown: n,
							cancelled: n,
							sent: n,
							open: n,
							leftOut: n,
							people,
							...(code ? { code } : {}),
							...(waiting ? { waiting } : {}),
						};
						return [mailReport.parse(Object.fromEntries(Object.entries(all).filter(([k]) => k in option.shape)))];
					}),
				),
			),
		);
	});
}
const distinct = <T,>(all: T[]) => [...new Map(all.map((x) => [JSON.stringify(x), x])).values()];

test("INV-mail-wording: whatever the email service confirmed, an email card's result never says an email was delivered", async () => {
	const said = new Set<string>();
	for (const report of distinct(reports()))
		for (const operation of OPERATION[report.kind]) {
			const { text } = await shown(
				reviewed(operation, mailChanges, {
					status: "approved",
					approvedAt: NOW,
					outcome: "completed",
					receipt: { receiptId: "r", report },
				}),
			);
			assert.equal(claims(text), null, `${operation} ${JSON.stringify(report)}: ${text}`);
			for (const [name, sentence] of Object.entries(CANNED)) if (text.includes(sentence)) said.add(name);
			if (report.kind === "send" && report.confirmation === "confirmed") assert.ok(text.includes(CANNED.notDelivered));
			if (
				(report.kind === "schedule" || report.kind === "replace") &&
				report.confirmation === "confirmed" &&
				report.waiting === undefined
			)
				assert.ok(text.includes(CANNED.accepted));
		}
	assert.deepEqual([...said].sort(), ["accepted", "notDelivered"]);
});

test("INV-mail-wording: before and around its result, an email card never says an email was delivered, and a send says accepted is not delivered", async () => {
	const states: Record<string, unknown>[] = [
		{},
		{ stale: true },
		{ expiresAt: "2026-10-21T11:00:00Z" },
		{ status: "cancelled" },
		{ status: "expired" },
		{ status: "approved", executing: true },
		{ status: "approved", outcome: "failed" },
		{ status: "approved", outcome: "unknown", expiresAt: "2026-10-21T11:00:00Z" },
		{ status: "approved", outcome: "completed" },
		...["revision_conflict", "mail_unavailable", "not_found", ...CODES].map((code) => ({
			status: "approved",
			outcome: "refused",
			receipt: { code },
		})),
	];
	for (const operation of MAIL)
		for (const state of states) {
			const { text } = await shown(reviewed(operation, mailChanges, state));
			assert.equal(claims(text), null, `${operation} ${JSON.stringify(state)}: ${text}`);
		}
	for (const operation of ["communication.sendReviewed", "evry.prepareMeetingInvitation", "evry.reuseRecipe"])
		assert.ok((await shown(reviewed(operation, mailChanges))).text.includes(CANNED.consequence), operation);
	for (const word of [
		...Object.values(RECIPIENT_OUTCOME),
		...Object.values(MAIL_DISMISSED),
		...CODES.map(stoppedReason),
	])
		assert.equal(claims(word), null, word);
	assert.deepEqual(
		Object.values(LEFT_OUT_REASON)
			.filter((reason) => DELIVERY.test(reason))
			.sort(),
		[REPORTED_BY_SERVICE, ...DEFERRED].sort(),
		"only an earlier email the email service itself reported as delivered is named so",
	);
});

const OTHER = "Nadia Other";
const OTHER_ID = "99999999-9999-4999-8999-999999999999";
const foreign = { actor: OTHER, name: OTHER, account: OTHER, label: OTHER, recipient: OTHER, accountId: OTHER_ID };
const notice = (id: string, title: string, category: string) => ({
	...foreign,
	id,
	title,
	category,
	at: "2026-10-21T15:00:00Z",
	zone: "America/Chicago",
});
const NOTICE_N = "33333333-3333-4333-8333-333333333333";
const slot = (cadence: string) => ({ ...foreign, cadence, weekday: 1, hour: 8 });

test("INV-notification-card: a notifications card shows only the viewer's own notices, counts and settings, whoever else the review names", async () => {
	const cards: Record<string, { changes: Change[]; subject: string; lines: string[] }> = {
		"notifications.markSelectedRead": {
			changes: [change("notice", "read", notice(NOTICE_N, "Ana Lee needs a follow-up", "task_due"))],
			subject: "Your notifications",
			lines: ["Ana Lee needs a follow-up", "Wed, Oct 21, 10:00 AM", "This notification"],
		},
		"notifications.markAllVisibleRead": {
			changes: [{ ...change("unread", 0, 12), ...foreign }],
			subject: "Your notifications",
			lines: ["12", "0"],
		},
		"notifications.setPreferences": {
			changes: [{ ...change("task_due.email", false, true), ...foreign }],
			subject: "Your notification settings",
			lines: ["Email", "On", "Off"],
		},
		"notifications.digestCadence.set": {
			changes: [change("planter_digest.cadence", slot("daily"), slot("weekly"))],
			subject: "Your church digest",
			lines: ["Weekly on Mondays at 8:00 AM", "Daily at 8:00 AM"],
		},
		"notifications.oversightDigestCadence.set": {
			changes: [change("oversight_digest.cadence", slot("weekly"), slot("daily"))],
			subject: "Your oversight digest",
			lines: ["Daily at 8:00 AM", "Weekly on Mondays at 8:00 AM"],
		},
	};
	for (const [operation, { changes, subject, lines }] of Object.entries(cards))
		for (const state of [
			{},
			{ status: "approved", approvedAt: NOW, outcome: "completed", receipt: { receiptId: "r" } },
		]) {
			const at = await shown(
				reviewed(operation, [], {
					review: {
						target: { kind: "account", id: OTHER_ID, label: OTHER },
						changes: [...changes, change("account", OTHER, OTHER), change("actor", OTHER_ID, OTHER)],
					},
					...state,
				}),
			);
			const all = at.lines.join("\n");
			assert.ok(all.includes(subject), `${operation}: ${all}`);
			for (const line of lines) assert.ok(all.includes(line), `${operation} ${line}: ${all}`);
			for (const hidden of [OTHER, OTHER_ID, NOTICE_N])
				assert.equal(all.includes(hidden), false, `${operation} shows ${hidden}: ${all}`);
		}
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PHOTO = "abcdef12-3456-4789-8abc-def012345678";
const BEFORE = "fedcba98-7654-4321-8fed-cba987654321";

test("INV-review-ids: no id on a review card is shown as a value; a photo shows only its 8-character reference", async () => {
	const person = { kind: "person", id: ID, label: "Maria Santos" };
	const cases: [string, Change[], Record<string, unknown> | null, string[]][] = [
		["people.setPersonPhoto", [change("photo", PHOTO, BEFORE)], person, ["Ref ABCDEF12", "Ref FEDCBA98"]],
		["people.setPersonPhoto", [change("photo", PHOTO, BEFORE)], null, ["Photo ABCDEF12", "Photo FEDCBA98"]],
		["people.removePersonPhoto", [change("photo", null, BEFORE)], person, ["Ref FEDCBA98"]],
		["account.finalizeAvatar", [change("photo", PHOTO, BEFORE)], { ...person, kind: "account" }, ["Ref ABCDEF12"]],
		["tasks.create", [change("title", "Call"), change("relatedTo", PHOTO)], null, ["A linked record"]],
		["tasks.edit", [change("relatedTo", PHOTO, BEFORE)], { ...person, kind: "task" }, ["A linked record"]],
		[
			"people.assignTag",
			[change("tag", PHOTO), change("createTag", "Welcome team")],
			person,
			["The tag Welcome team will be created."],
		],
		["people.removeTag", [change("tag", null, PHOTO), change("note", "Kept")], person, ["Maria Santos"]],
		[
			"people.deletePerson",
			[change("reason", "Moved"), change("openTasksNeedingOwner", PHOTO, BEFORE)],
			person,
			["Moved"],
		],
		[
			"discovery.convertToPlant",
			[
				change("church", "Hope"),
				change(`link:${PHOTO}`, { carries: true, share: [] }, { organization: "Grace", kind: "Sending church" }),
			],
			null,
			["Grace"],
		],
		[
			"communication.saveDraft",
			[
				change("subject", "Hi"),
				change("body", "Hi"),
				change("audience", { ...audience, teamIds: [PHOTO], personIds: [BEFORE] }),
			],
			null,
			["1 team", "1 person"],
		],
		[
			"notifications.markSelectedRead",
			[change("notice", "read", notice(PHOTO, "Call is due", "task_due"))],
			null,
			["Call is due"],
		],
		["phases.declare", [change("phase", { phase: 2, id: PHOTO, name: "Gathering" })], null, ["Gathering"]],
		["signals.reaffirm", [change("signal", { key: PHOTO, label: "Prayer team" })], null, ["Prayer team"]],
	];
	globalThis.fetch = (async () => Response.json({}, { status: 403 })) as typeof fetch;
	for (const [operation, changes, target, lines] of cases) {
		const at = await shown(reviewed(operation, changes, { review: { target, changes } }));
		const values = at.lines.join("\n");
		assert.doesNotMatch(values, UUID, `${operation}: ${values}`);
		for (const line of lines) assert.ok(at.text.includes(line), `${operation} ${line}: ${at.text}`);
	}
});

const REASON = "Finished the spring apprenticeship";
const move = () =>
	reviewed("pipeline.proposeStageMove", [change("pipelineStage", "Resident", "Apprentice")], {
		review: {
			target: { kind: "person", id: ID, label: "Casey Lee" },
			changes: [change("pipelineStage", "Resident", "Apprentice")],
		},
	});

function recorded(answer: (call: string) => Response | Error) {
	const sent: { call: string; seen: string }[] = [];
	globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
		const call = `${init.method ?? "GET"} ${String(url).split("/").at(-1)}`;
		sent.push({ call, seen: JSON.stringify([url, init.headers ?? null, init.body ?? null]) });
		const reply = answer(call);
		if (reply instanceof Error) throw reply;
		return reply;
	}) as typeof fetch;
	return sent;
}
const refusal = (code: string) =>
	Response.json({ error: { code, correlationId: "x", retry: "never", outcome: "refused" } }, { status: 409 });
async function typed() {
	const at = await card(move());
	await at.run(() => propsOf(at.byTag("TEXTAREA")[0]!).onChange?.({ target: { value: REASON } }));
	return at;
}

test("INV-pipeline-reason: the reason typed on a move's card is sent with Approve and with nothing else the card sends", async () => {
	const sent = recorded((call) =>
		call === "POST approve" ? refusal("review_changed") : call.startsWith("GET") ? Response.json(move()) : refusal("x"),
	);
	const at = await typed();
	await at.click("Approve");
	await at.click("Cancel");
	await at.unmount();

	const offline = recorded(() => new Error("offline"));
	const lost = await typed();
	await lost.click("Approve");
	await lost.click("Check again");
	await lost.unmount();

	const cancelled = recorded(() => new Error("offline"));
	const dropped = await typed();
	await dropped.click("Cancel");
	await dropped.click("Check again");
	await dropped.unmount();

	const all = [...sent, ...offline, ...cancelled];
	assert.deepEqual([...new Set(all.map((s) => s.call))].sort(), ["GET " + ID, "POST approve", "POST cancel"]);
	for (const { call, seen } of all) assert.equal(seen.includes(REASON), call === "POST approve", `${call}: ${seen}`);
});

test("INV-pipeline-reason: after an approval with a reason, the card's reads, revise, retry, checks and cancel do not carry it", async () => {
	const { createReviewStore } = await import("../../../apps/web/src/features/evry/review/ReviewCard.store.ts");
	const api = await import("../../../apps/web/src/features/evry/review/api.ts");
	const sent = recorded((call) => (call === "POST approve" ? refusal("review_changed") : new Error("offline")));
	const store = createReviewStore({
		id: ID,
		seed: move() as never,
		port: { ...api, refresh() {}, church },
	});
	const { actions } = store.getState();
	await actions.approve(REASON);
	for (const step of ["revise", "retry", "recheck", "cancel", "check"] as const) await actions[step]();
	await Promise.all([api.readReview(ID), api.readStagedPhoto(ID)]);
	assert.deepEqual([...new Set(sent.map((s) => s.call))].sort(), [
		"GET " + ID,
		"GET photo",
		"POST approve",
		"POST cancel",
		"POST check",
		"POST retry",
		"POST revise",
	]);
	for (const { call, seen } of sent) assert.equal(seen.includes(REASON), call === "POST approve", `${call}: ${seen}`);
});

test("INV-review-footer: a view change gives the card a new footer element, so a focused control never turns into another one; a render in the same view keeps it", async (t) => {
	recorded(() => new Error("offline"));
	const at = await card(move());
	t.after(() => at.unmount());
	const footerOf = (label: string) => {
		const control = at.byTag("BUTTON").find((n) => n.textContent.trim() === label);
		assert.ok(control, `no ${label} in: ${at.text()}`);
		return { control, footer: control.parentNode };
	};
	const first = footerOf("Cancel");
	await at.run(() => propsOf(at.byTag("TEXTAREA")[0]!).onChange?.({ target: { value: REASON } }));
	const typing = footerOf("Cancel");
	assert.ok(typing.footer === first.footer && typing.control === first.control, "the same view keeps the footer");

	await at.click("Approve");
	const unknown = footerOf("Check again");
	assert.ok(unknown.footer !== first.footer, "another view has a footer of its own");
	assert.ok(unknown.footer?.contains(unknown.control));
	assert.ok(!at.all().includes(first.control), "no control of the old view stays");
});
