import assert from "node:assert/strict";
import { test } from "node:test";
import { shellNav, type NavViewer } from "../../../apps/web/src/features/shell/nav.ts";

const labels = (viewer: NavViewer) => {
	const nav = shellNav(viewer);
	return { links: [...nav.main, ...nav.pages].map((link) => link.label), guide: nav.guide };
};

test("an account with no church yet is offered neither Wiki nor the wiki Guide, only Documents", () => {
	assert.deepEqual(labels({ context: "pending" }), { links: ["Documents"], guide: false });
});

test("once the account creates or joins a church, every seat sees Wiki and the Guide", () => {
	for (const role of ["owner", "admin", "member"] as const) {
		const { links, guide } = labels({ context: "plant", role });
		assert.ok(links.includes("Wiki"), role);
		assert.equal(guide, true, role);
	}
});

test("a signed-up account without a seat keeps Wiki, which it can read", () => {
	assert.deepEqual(labels({ context: "account", residencyLinked: false }), { links: ["Wiki", "Documents"], guide: true });
	assert.deepEqual(labels({ context: "account", residencyLinked: true }), {
		links: ["My residency", "Wiki", "Documents"],
		guide: true,
	});
});
