// WP-104/ui slice 2: the client half of the "Logos and images" rules (apps/web/src/features/settings/brand/assets.ts).
// The fixture brand port stands in for the server and records what each step sends; the server's own refusals
// (access, conflict, alt text, media type) are proved in tests/integration/branding/branding.test.mts.
//   AC:CASE-BRD-002: upload and remove a slot; alt text is required on the client and reads the server's words;
//     the brand swatch follows the draft primary color, or neutral ink with a note.
//   AC:CASE-BRD-003 (suggest-from-logo): a suggestion changes nothing until the person chooses it.
//   AC:CASE-BRD-006: the preview places the stored assets.
//   INV-brand-assets-conflict: finalize sends the revision read when it starts, and a conflict reaches the slot.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ASSET_MAX_BYTES } from "../../../packages/contracts/src/branding/values.ts";
import {
	ALT_REQUIRED,
	altProblem,
	assetMessage,
	backgrounds,
	fileProblem,
	removeAsset,
	suggestFor,
	uploadAsset,
	withoutAsset,
} from "../../../apps/web/src/features/settings/brand/assets.ts";
import { createFixtureBrand, type BrandFault } from "../../../apps/web/src/features/settings/brand/fixtures.ts";
import { formOf, patchOf, themeOf } from "../../../apps/web/src/features/settings/brand/model.ts";
import type { BrandPort } from "../../../apps/web/src/features/settings/port.ts";

const logo = (type = "image/svg+xml", bytes = 400) => new File([new Uint8Array(bytes)], "logo.svg", { type });

/** The fixture port, refusing the operations in `fault` once, with every call and its argument recorded. */
function port(options: { fault?: Partial<Record<string, BrandFault>> } = {}) {
	const faults = new Map(Object.entries(options.fault ?? {}));
	const calls: [string, unknown][] = [];
	const brand = createFixtureBrand({
		kit: "saved",
		churchName: "Harvest Point Church",
		canAdmin: true,
		tick: async (op) => {
			const fault = faults.get(op) ?? null;
			faults.delete(op);
			return fault;
		},
		nextId: randomUUID,
	});
	const recorded = Object.fromEntries(
		Object.entries(brand).map(([name, fn]) => [
			name,
			(...args: unknown[]) => {
				if (name !== "assetSrc") calls.push([name, args[0]]);
				return (fn as (...a: unknown[]) => unknown)(...args);
			},
		]),
	) as unknown as BrandPort;
	return { calls, brand: recorded, ops: () => calls.map(([op]) => op) };
}

async function kitOf(p: ReturnType<typeof port>) {
	const reply = await p.brand.get();
	return reply.status === "ok" ? reply.value.kit : assert.fail("get refused");
}

test("AC:CASE-BRD-002 an upload sends request, bytes and finalize in order and returns the stored kit", async () => {
	const p = port();
	const before = await kitOf(p);
	const file = logo();
	const outcome = await uploadAsset(p.brand, {
		slot: "full_logo",
		file,
		altText: "Harvest Point logo",
		revision: () => before.revision,
	});
	assert.deepEqual(p.ops().slice(1), ["requestUpload", "uploadBytes", "finalizeUpload"]);
	const [, request] = p.calls[1]!;
	assert.deepEqual(request, {
		slot: "full_logo",
		mediaType: "image/svg+xml",
		byteLength: 400,
		altText: "Harvest Point logo",
	});
	const uploadId = (p.calls[3]![1] as { uploadId: string }).uploadId;
	assert.deepEqual(p.calls[3]![1], {
		uploadId,
		slot: "full_logo",
		altText: "Harvest Point logo",
		expectedRevision: before.revision,
	});
	assert.deepEqual(outcome, { ok: true, kit: await kitOf(p) });
});

test("AC:CASE-BRD-002 a refused step ends the upload with that step's error and sends no later step", async () => {
	const steps = ["requestUpload", "uploadBytes", "finalizeUpload"] as const;
	for (const [i, step] of steps.entries()) {
		for (const code of ["invalid_file", "unsupported_media_type", "unavailable"] as const) {
			const p = port({ fault: { [step]: code } });
			const outcome = await uploadAsset(p.brand, { slot: "mark", file: logo(), altText: "Mark", revision: () => "1" });
			assert.equal(outcome.ok, false);
			assert.equal(outcome.ok ? null : outcome.error?.code, code, `${step} ${code}`);
			assert.deepEqual(p.ops(), steps.slice(0, i + 1), `${step} ${code}`);
		}
	}
});

test("AC:CASE-BRD-002 a removal empties only that slot at once and saves one patch at the current revision", async () => {
	const p = port();
	const up = await uploadAsset(p.brand, { slot: "signature", file: logo(), altText: "Signature", revision: () => "1" });
	const kit = up.ok ? up.kit : assert.fail("upload refused");
	assert.deepEqual(withoutAsset(kit, "signature"), { ...kit, assets: { ...kit.assets, signature: null } });

	p.calls.length = 0;
	const removed = await removeAsset(p.brand, "signature", kit.revision);
	assert.deepEqual(p.calls, [["save", { expectedRevision: kit.revision, patch: { assets: { signature: null } } }]]);
	assert.deepEqual(removed, { ok: true, kit: await kitOf(p) });

	const refusing = port({ fault: { saveBrand: "unavailable" } });
	const refused = await removeAsset(refusing.brand, "mark", "1");
	assert.equal(refused.ok ? null : refused.error?.code, "unavailable");
});

test("AC:CASE-BRD-002 alt text is required: blank text is refused on the client, and the server's refusal reads the same words", async () => {
	assert.equal(altProblem("   "), ALT_REQUIRED);
	assert.equal(altProblem(""), ALT_REQUIRED);
	assert.equal(altProblem("A logo"), null);
	// A client that skips its own check is refused at the first step; no bytes are sent.
	const p = port();
	const outcome = await uploadAsset(p.brand, { slot: "full_logo", file: logo(), altText: "  ", revision: () => "1" });
	const error = outcome.ok ? assert.fail("blank alt text uploaded") : outcome.error!;
	assert.equal(error.code, "alt_text_required");
	assert.equal(assetMessage(error), ALT_REQUIRED);
	assert.deepEqual(p.ops(), ["requestUpload"]);
});

test("AC:CASE-BRD-002 the client refuses a wrong type and an oversize file before any request", () => {
	assert.match(fileProblem({ size: 10, type: "image/gif" }) ?? "", /SVG, PNG or WebP/);
	assert.match(fileProblem({ size: ASSET_MAX_BYTES + 1, type: "image/png" }) ?? "", /3 MB/);
	assert.equal(fileProblem({ size: ASSET_MAX_BYTES, type: "image/webp" }), null);
	assert.equal(fileProblem({ size: 1, type: "image/svg+xml" }), null);
});

test("INV-brand-assets-conflict: finalize sends the revision read when it starts, and a conflict reaches the slot", async () => {
	const p = port();
	let revision = "0";
	const outcome = uploadAsset(p.brand, {
		slot: "mark",
		file: logo(),
		altText: "Mark",
		revision: () => revision,
	});
	// Another save lands while the bytes upload: finalize must carry the revision as it is then.
	revision = "1";
	assert.ok((await outcome).ok);
	assert.equal(
		(p.calls.find(([op]) => op === "finalizeUpload")![1] as { expectedRevision: string }).expectedRevision,
		"1",
	);

	const stale = await uploadAsset(p.brand, { slot: "mark", file: logo(), altText: "Mark", revision: () => "1" });
	assert.equal(stale.ok ? null : stale.error?.code, "conflict");
});

test("AC:CASE-BRD-003 a suggestion changes nothing until chosen, and a chosen color saves only on Save", async () => {
	const p = port();
	const up = await uploadAsset(p.brand, { slot: "full_logo", file: logo(), altText: "Logo", revision: () => "1" });
	const kit = up.ok ? up.kit : assert.fail("upload refused");
	p.calls.length = 0;
	const suggestion = await suggestFor(p.brand, "full_logo");
	assert.deepEqual(p.calls, [["suggestColors", { assetKind: "full_logo" }]], "asking for a suggestion saves nothing");
	assert.equal(suggestion?.suggestedPrimary, "#2E7D32");
	const saved = formOf(kit);
	assert.deepEqual(patchOf(saved, saved), {});
	// Choosing sets the draft only; the patch then carries the primary color and nothing else.
	assert.deepEqual(patchOf({ ...saved, primaryColor: suggestion!.suggestedPrimary }, saved), {
		primaryColor: "#2E7D32",
	});
	// A refused or missing suggestion is never an error.
	assert.equal(await suggestFor(port({ fault: { suggestColors: "unavailable" } }).brand, "mark"), null);
});

test("AC:CASE-BRD-006 the preview places the stored assets and keeps the type fallback without them", async () => {
	const kit = await kitOf(port());
	const none = themeOf("Harvest Point Church", formOf(kit), "formal/legal", kit.assets).layout;
	assert.equal(none.documentClass === "formal/legal" && none.headerLogo, null);
	const ref = (alt: string) => ({ fileId: randomUUID(), alt });
	const assets = {
		...kit.assets,
		full_logo: ref("Logo"),
		mark: ref("Mark"),
		cover_photo: ref("Cover"),
		signature: ref("Sign"),
	};
	const layout = (c: Parameters<typeof themeOf>[2]) => themeOf("Harvest Point Church", formOf(kit), c, assets).layout;
	const formal = layout("formal/legal");
	assert.deepEqual(formal.documentClass === "formal/legal" && [formal.headerLogo, formal.signature.image], [
		assets.full_logo,
		assets.signature,
	]);
	const outward = layout("outward-facing");
	assert.deepEqual(outward.documentClass === "outward-facing" && [outward.coverLogo, outward.coverPhoto], [
		assets.full_logo,
		assets.cover_photo,
	]);
	const operational = layout("operational");
	assert.deepEqual(operational.documentClass === "operational" && operational.mark, assets.mark);
	const email = layout("email");
	assert.deepEqual(email.documentClass === "email" && email.headerLogo, assets.full_logo);
});

test("AC:CASE-BRD-002 the brand swatch is the draft primary color, or neutral ink with a note", () => {
	assert.deepEqual(backgrounds("#1F4E79" as never, "#1A1A1A")[2], { name: "Brand", color: "#1F4E79" });
	const neutral = backgrounds(null, "#1A1A1A")[2]!;
	assert.equal(neutral.color, "#1A1A1A");
	assert.match(neutral.note ?? "", /neutral ink/);
});
