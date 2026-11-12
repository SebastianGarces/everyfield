// T-260 (D-731 to D-733): a feed entry whose category has a subject page links to it, read or unread; any other entry is
// a mark-read button while unread and plain text once read. It maps each subject the feed returns to its address and
// renders the real entry in node. It runs from packages/domain's test:unit:
// tsx --tsconfig ../../tests/ui/render.tsconfig.json --test <this file>.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FeedItem } from "../../../apps/web/src/features/notifications/model.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
// Links go through the app router; a router that goes nowhere stands in for the mounted one.
const { AppRouterContext } = web("next/dist/shared/lib/app-router-context.shared-runtime");
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const { subjectHref } = await import("../../../apps/web/src/features/notifications/model.ts");
const { NotificationItem } = await import("../../../apps/web/src/features/notifications/parts.tsx");

const id = "5a86c45a-0632-4ed7-bf92-ec829e7c65cc";
const base: FeedItem = {
	id: "0f6b1c1e-3f43-4f7a-9d83-5d0c2f3e9b11",
	category: "scheduled_email_unsubscribe",
	title: "Ana Ruiz unsubscribed from a scheduled email",
	body: null,
	eligibleAt: "2026-11-11T15:00:00.000Z",
	read: false,
	dueLocalDate: null,
	overdue: false,
	subject: { kind: "communication", id },
};
const html = (item: FeedItem) =>
	renderToStaticMarkup(
		createElement(
			AppRouterContext.Provider,
			{ value: router },
			createElement(NotificationItem, { item, clock: null, onRead: () => {} }),
		),
	);

test("AC:CASE-NTF-003 each subject opens its page", () => {
	assert.equal(subjectHref({ kind: "communication", id }), `/communication?message=${id}`);
	assert.equal(subjectHref({ kind: "task", id }), `/tasks?task=${id}`);
	assert.equal(subjectHref({ kind: "meeting", id }), `/meetings/${id}`);
	assert.equal(
		subjectHref({ kind: "article", id, slug: "launch/core group" }),
		"/wiki/launch/core%20group?source=global",
	);
	assert.equal(subjectHref(null), null);
});

test("AC:CASE-NTF-003 a linked entry is one link read or unread; an unlinked one is a button, then text", () => {
	const unreadLink = html(base);
	assert.match(unreadLink, new RegExp(`^<li><a [^>]*href="/communication\\?message=${id}"`));
	assert.match(unreadLink, /class="[^"]*cursor-pointer[^"]*focus-visible:shadow/);
	assert.match(unreadLink, /<span class="sr-only">Unread: <\/span>/);
	assert.match(unreadLink, /Ana Ruiz unsubscribed from a scheduled email/);
	assert.doesNotMatch(unreadLink, /<button|Mark as read/);

	const readLink = html({ ...base, read: true });
	assert.match(readLink, new RegExp(`<a [^>]*href="/communication\\?message=${id}"`));
	assert.doesNotMatch(readLink, /Unread:|<button/);

	const digest = { ...base, category: "oversight_digest", title: "Your plants this week", subject: null } as const;
	const unreadDigest = html(digest);
	assert.match(unreadDigest, /^<li><button type="button"/);
	assert.match(unreadDigest, /Mark as read/);
	assert.doesNotMatch(unreadDigest, /<a /);
	const readDigest = html({ ...digest, read: true });
	assert.match(readDigest, /^<li><div class=/);
	assert.doesNotMatch(readDigest, /<a |<button/);
});
