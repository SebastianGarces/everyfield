// T-125: the library renders a template once per page load. A thumbnail and the selected template's preview with the
// same values share one POST /documents/preview, and the render key names everything that changes the bytes, so a new
// library version, format, override or church value draws a fresh picture while an unchanged load reuses it. A silent
// break either doubles the slowest request on /documents or shows a stale thumbnail after the church's values change.
// No browser: the real modules run in node, with fetch counting the posts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { churchValues, renderKey, type Resolved } from "../../../apps/web/src/features/documents/model.ts";
import { sharedPreview } from "../../../apps/web/src/features/documents/preview-client.ts";

const base = {
	templateId: "vision-card",
	version: "a".repeat(64),
	format: "pdf" as const,
	overrides: {},
	church: { church_name: "Grace Church", pastor_name: "Ana Ruiz" },
};

const context: Resolved = {
	templateId: "vision-card",
	format: "pdf",
	fields: [
		{ key: "church_name", label: "Church name", required: true, value: "Grace Church", source: "church_name" },
		{ key: "pastor_name", label: "Pastor", required: false, value: "Ana Ruiz", source: "pastor_name" },
		{ key: "tagline", label: "Tagline", required: false, value: "Typed here", source: "override" },
		{ key: "launch_date", label: "Launch date", required: false, value: null, source: "absent" },
	],
	missing: [],
	complete: true,
};

test("the church values of a page load are the values the church supplies, not typed or absent ones", () => {
	assert.deepEqual(churchValues(context), { church_name: "Grace Church", pastor_name: "Ana Ruiz" });
	assert.deepEqual(churchValues(null), {});
});

test("an unchanged load gives the same key, whatever order the values arrive in", () => {
	assert.equal(
		renderKey(base),
		renderKey({ ...base, church: { pastor_name: "Ana Ruiz", church_name: "Grace Church" } }),
	);
	assert.equal(
		renderKey({ ...base, overrides: { a: "1", b: "2" } }),
		renderKey({ ...base, overrides: { b: "2", a: "1" } }),
	);
});

test("a change to the template, the library version, the format, an override or a church value gives a new key", () => {
	const changed = [
		{ ...base, templateId: "bylaws" },
		{ ...base, version: "b".repeat(64) },
		{ ...base, format: "docx" as const },
		{ ...base, overrides: { tagline: "New" } },
		{ ...base, church: { ...base.church, church_name: "Grace Fellowship" } },
		{ ...base, church: { church_name: "Grace Church" } },
	];
	const keys = new Set([renderKey(base), ...changed.map(renderKey)]);
	assert.equal(keys.size, changed.length + 1);
});

test("a thumbnail and the preview of the same template and values post one preview request; other values post their own", async () => {
	const posts: unknown[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		posts.push(JSON.parse(String(init.body)));
		const value = {
			templateId: "vision-card",
			format: "pdf",
			fields: [],
			missing: [],
			complete: true,
			artifact: "JVBE",
		};
		return new Response(JSON.stringify({ status: "ok", value }));
	}) as typeof fetch;
	try {
		const key = renderKey(base);
		// The thumbnail asks first, the selected template's preview while it is still in flight, and again once done.
		const thumbnail = sharedPreview(key, "vision-card", "pdf", {});
		const preview = sharedPreview(key, "vision-card", "pdf", {});
		assert.deepEqual(await thumbnail, await preview);
		await sharedPreview(key, "vision-card", "pdf", {});
		assert.equal(posts.length, 1);
		// Typed values are another render.
		const typed = { tagline: "Join us" };
		await sharedPreview(renderKey({ ...base, overrides: typed }), "vision-card", "pdf", typed);
		assert.deepEqual(posts, [
			{ templateId: "vision-card", format: "pdf", overrides: {} },
			{ templateId: "vision-card", format: "pdf", overrides: typed },
		]);
	} finally {
		globalThis.fetch = original;
	}
});

test("a failed render is not kept: the next ask posts again", async () => {
	let posts = 0;
	const original = globalThis.fetch;
	globalThis.fetch = (async () => {
		posts += 1;
		return new Response(JSON.stringify({ status: "refused", code: "render_failed" }));
	}) as typeof fetch;
	try {
		const key = renderKey({ ...base, templateId: "failing" });
		assert.equal((await sharedPreview(key, "failing", "pdf", {})).status, "refused");
		assert.equal((await sharedPreview(key, "failing", "pdf", {})).status, "refused");
		assert.equal(posts, 2);
	} finally {
		globalThis.fetch = original;
	}
});
