import "../runs-in/render-module-mocks.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { HubState, MessageView } from "../../../apps/web/src/features/communication/model.ts";

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const noAction = () => assert.fail("no action runs while rendering");
mock.module(new URL("../../../apps/web/src/features/communication/actions.ts", import.meta.url).href, {
	namedExports: {
		cancelScheduled: noAction,
		reconcileDelivery: noAction,
		replaceScheduled: noAction,
		rescheduleDispatched: noAction,
		saveResend: noAction,
		sendReviewed: noAction,
	},
});
const { TonePill } = await import("../../../packages/ui/src/display/index.ts");
const { Detail } = await import("../../../apps/web/src/features/communication/HistoryPanel.tsx");

const ID = "6a1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const nothing = () => undefined;

function view(state: HubState, counts: Partial<MessageView["totals"]>): MessageView {
	return {
		detail: {
			communicationId: ID,
			revision: "1",
			state: "scheduled",
			subject: "Vision night",
			bodyHtml: null,
			bodyText: "Join us.",
			meetingId: null,
			scheduledAt: "2026-11-30T15:00:00.000Z",
			requestedAt: null,
			sentAt: null,
			senderName: null,
			deliveryAddress: null,
			currentPersonAddress: null,
			deliveryStatus: null,
			recipients: [
				{
					personId: ID,
					deliveryAddress: "ana@example.test",
					currentPersonAddress: "ana@example.test",
					deliveryStatus: "unsubscribed",
					sentTo: null,
					sentAt: null,
					deliveredAt: null,
					openedAt: null,
					clickedAt: null,
				},
			],
		},
		totals: {
			communicationId: ID,
			state,
			selected: 0,
			reachable: 0,
			attempted: 0,
			accepted: 0,
			sent: 0,
			delivered: 0,
			opened: 0,
			clicked: 0,
			bounced: 0,
			failed: 0,
			suppressed: 0,
			unsubscribed: 0,
			child: 0,
			guardian: 0,
			unknown: 0,
			cancelled: 0,
			cancelOpen: 0,
			asOf: "2026-11-24T10:00:00.000Z",
			rate: null,
			outcomes: [],
			sentForAll: false,
			...counts,
		},
		recipients: [
			{
				personId: ID,
				name: "Ana",
				deliveryStatus: "unsubscribed",
				deliveryAddress: "ana@example.test",
			},
		],
		recipientsComplete: true,
	};
}
const html = (message: MessageView): string =>
	renderToStaticMarkup(
		createElement(Detail, {
			view: message,
			canWrite: true,
			review: null,
			reviewError: null,
			pending: null,
			onReview: nothing,
			onConfirm: nothing,
			onPerson: nothing,
			onMeeting: nothing,
			keepScope: false,
			churchName: "Grace",
			mailingAddress: null,
			origin: "https://app.example.test",
			scheduled: {
				pending: null,
				notice: null,
				onSendNow: nothing,
				onCancel: nothing,
				onCheckCancel: nothing,
				onReconcile: nothing,
				onReplace: nothing,
				onReschedule: nothing,
			},
			notice: null,
		}),
	);

test("INV-counts: an unsubscribed recipient won't receive a message that has not gone out, and is Skipped once it has", () => {
	const before = html(view("scheduled", { unsubscribed: 1 }));
	assert.ok(before.includes("Unsubscribed, won&#x27;t receive this"));
	assert.ok(!before.includes("Skipped: unsubscribed"));
	const gone = html(view("sent", { unsubscribed: 1 }));
	assert.ok(gone.includes("Skipped: unsubscribed"));
	assert.ok(!gone.includes("Unsubscribed, won&#x27;t receive this"));
});

test("INV-counts: a message whose recipients all unsubscribed reads Not sent: unsubscribed with a neutral badge and nothing refused", () => {
	const shown = html(view("unsubscribed", { selected: 2, unsubscribed: 2 }));
	const label = "Not sent: unsubscribed";
	const badge = (tone: string): string => renderToStaticMarkup(createElement(TonePill, { tone, children: label }));
	assert.ok(shown.includes(badge("neutral")));
	assert.notEqual(badge("neutral"), badge("error"));
	assert.ok(shown.includes("it does not go out. This is not an error."));
	assert.doesNotMatch(shown, /Refused/);
});

test("INV-counts: the held status counts unsubscribed people apart from the refused", () => {
	for (const state of ["not_scheduled", "failed", "unknown", "sending"] as const)
		assert.ok(
			html(view(state, { failed: 1, unsubscribed: 2 })).includes("Refused 1. No answer 0. Unsubscribed 2."),
			state,
		);
});
