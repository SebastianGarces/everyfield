// WP-104/ui slice 2: the "Logos and images" rules (apps/web/src/features/settings/brand/assets.ts) run through the
// fixture brand port, whose replies the branding contract's own schemas parse. No browser, no database.
//   AC:CASE-BRD-002: upload, replace and remove a slot; alt text is required on the client and on the server;
//     the brand swatch follows the draft primary color, or neutral ink with a note.
//   AC:CASE-BRD-003 (suggest-from-logo): a suggestion changes nothing until the person chooses it.
//   INV-brand-assets-access: a Member's upload request, byte upload, finalize and suggest are each refused.
//   INV-brand-assets-conflict: a stale revision refuses finalize with `conflict`; the picked file stays usable.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ASSET_MAX_BYTES } from "../../../packages/contracts/src/branding/values.ts";
import {
	ALT_REQUIRED,
	altProblem,
	assetMessage,
	backgrounds,
	canSuggest,
	fileProblem,
	removeAsset,
	suggestFor,
	uploadAsset,
	withoutAsset,
} from "../../../apps/web/src/features/settings/brand/assets.ts";
import { createFixtureBrand, type BrandFault } from "../../../apps/web/src/features/settings/brand/fixtures.ts";
import { formOf, patchOf, themeOf } from "../../../apps/web/src/features/settings/brand/model.ts";

const logo = (type = "image/svg+xml", bytes = 400) => new File([new Uint8Array(bytes)], "logo.svg", { type });

function port(options: { canAdmin?: boolean; fault?: Partial<Record<string, BrandFault>> } = {}) {
	const faults = new Map(Object.entries(options.fault ?? {}));
	const calls: string[] = [];
	return {
		calls,
		/** Refuse the next call of an operation. */
		arm: (op: string, fault: BrandFault) => faults.set(op, fault),
		brand: createFixtureBrand({
			kit: "saved",
			churchName: "Harvest Point Church",
			canAdmin: options.canAdmin ?? true,
			tick: async (op) => {
				calls.push(op);
				const fault = faults.get(op) ?? null;
				faults.delete(op);
				return fault;
			},
			nextId: randomUUID,
		}),
	};
}

async function kitOf(p: ReturnType<typeof port>) {
	const reply = await p.brand.get();
	assert.equal(reply.status, "ok");
	return reply.status === "ok" ? reply.value.kit : assert.fail();
}

test("upload into an empty slot sends the three steps and returns the kit at the next revision", async () => {
	const p = port();
	const before = await kitOf(p);
	assert.equal(before.assets.full_logo, null);
	const outcome = await uploadAsset(p.brand, {
		slot: "full_logo",
		file: logo(),
		altText: "Harvest Point logo",
		revision: () => before.revision,
	});
	assert.ok(outcome.ok);
	if (!outcome.ok) return;
	assert.deepEqual(p.calls.slice(1), ["requestUpload", "uploadBytes", "finalizeUpload"]);
	assert.equal(outcome.kit.revision, String(BigInt(before.revision) + 1n));
	assert.equal(outcome.kit.assets.full_logo?.alt, "Harvest Point logo");
	assert.notEqual(p.brand.assetSrc(outcome.kit.assets.full_logo!.fileId), "");
});

test("replace swaps the image and alt text; a refused replace leaves the old image and alt text stored", async () => {
	const p = port();
	const first = await uploadAsset(p.brand, { slot: "mark", file: logo(), altText: "Old mark", revision: () => "1" });
	assert.ok(first.ok);
	if (!first.ok) return;
	const old = first.kit.assets.mark!;

	p.arm("uploadBytes", "invalid_file");
	const refused = await uploadAsset(p.brand, {
		slot: "mark",
		file: logo(),
		altText: "New mark",
		revision: () => first.kit.revision,
	});
	assert.ok(!refused.ok && refused.error?.code === "invalid_file");
	const kept = await kitOf(p);
	assert.equal(kept.assets.mark?.fileId, old.fileId);
	assert.equal(kept.assets.mark?.alt, "Old mark");
	assert.equal(kept.revision, first.kit.revision);

	const second = await uploadAsset(p.brand, {
		slot: "mark",
		file: logo(),
		altText: "New mark",
		revision: () => first.kit.revision,
	});
	assert.ok(second.ok);
	if (!second.ok) return;
	assert.notEqual(second.kit.assets.mark!.fileId, old.fileId);
	assert.equal(second.kit.assets.mark!.alt, "New mark");
});

test("a refused removal leaves the image and alt text stored; a kit with no primary color refuses it", async () => {
	const p = port();
	let kit = await kitOf(p);
	const up = await uploadAsset(p.brand, {
		slot: "signature",
		file: logo(),
		altText: "Signature",
		revision: () => kit.revision,
	});
	assert.ok(up.ok);
	if (up.ok) kit = up.kit;
	assert.equal(withoutAsset(kit, "signature").assets.signature, null);
	assert.equal(kit.assets.signature?.alt, "Signature");

	p.arm("saveBrand", "unavailable");
	const refused = await removeAsset(p.brand, "signature", kit.revision);
	assert.ok(!refused.ok && refused.error?.code === "unavailable");
	const kept = await kitOf(p);
	assert.equal(kept.assets.signature?.alt, "Signature");
	assert.equal(kept.assets.signature?.fileId, kit.assets.signature?.fileId);
	assert.equal(kept.revision, kit.revision);

	const removed = await removeAsset(p.brand, "signature", kit.revision);
	assert.ok(removed.ok);
	if (removed.ok) assert.equal(removed.kit.assets.signature, null);

	// The server needs a saved primary color for any save, a removal included: the screen turns Remove off then.
	const bare = createFixtureBrand({
		kit: "none",
		churchName: "Harvest Point Church",
		canAdmin: true,
		tick: async () => null,
		nextId: randomUUID,
	});
	const fetched = await bare.get();
	const bareKit = fetched.status === "ok" ? fetched.value.kit : assert.fail();
	assert.equal(bareKit.primaryColor, null);
	const noPrimary = await removeAsset(bare, "signature", bareKit.revision);
	assert.ok(!noPrimary.ok && noPrimary.error?.code === "primary_required");
});

test("alt text is required on the client and the server", async () => {
	assert.equal(altProblem("   "), ALT_REQUIRED);
	assert.equal(altProblem(""), ALT_REQUIRED);
	assert.equal(altProblem("A logo"), null);
	const p = port();
	// The server still refuses blank text when a client skips its own check; no file is attached.
	const outcome = await uploadAsset(p.brand, { slot: "full_logo", file: logo(), altText: "  ", revision: () => "1" });
	assert.ok(!outcome.ok && outcome.error?.code === "alt_text_required");
	assert.equal(assetMessage(outcome.ok ? assert.fail() : outcome.error!), ALT_REQUIRED);
	assert.equal((await kitOf(p)).assets.full_logo, null);
});

test("the client refuses a wrong type and an oversize file before any request", () => {
	assert.match(fileProblem({ size: 10, type: "image/gif" }) ?? "", /SVG, PNG or WebP/);
	assert.match(fileProblem({ size: ASSET_MAX_BYTES + 1, type: "image/png" }) ?? "", /3 MB/);
	assert.equal(fileProblem({ size: ASSET_MAX_BYTES, type: "image/webp" }), null);
	assert.equal(fileProblem({ size: 1, type: "image/svg+xml" }), null);
});

test("each server refusal reads in its own plain words", async () => {
	const words = new Set<string>();
	for (const code of [
		"unsupported_media_type",
		"invalid_file",
		"invalid_input",
		"access_denied",
		"unavailable",
	] as const) {
		const refused = await uploadAsset(port({ fault: { requestUpload: code } }).brand, {
			slot: "full_logo",
			file: logo(),
			altText: "x",
			revision: () => "1",
		});
		assert.ok(!refused.ok && refused.error?.code === code);
		words.add(assetMessage(refused.error!));
	}
	assert.equal(words.size, 5);
});

test("a Member's upload, byte upload, finalize, remove and suggest are each refused", async () => {
	const p = port({ canAdmin: false });
	const request = await p.brand.requestUpload({ slot: "mark", mediaType: "image/png", byteLength: 10, altText: "x" });
	assert.ok(request.status === "refused" && request.error.code === "access_denied");
	const bytes = await p.brand.uploadBytes(randomUUID(), logo());
	assert.ok(bytes.status === "refused" && bytes.error.code === "access_denied");
	const finalized = await p.brand.finalizeUpload({
		uploadId: randomUUID(),
		slot: "mark",
		altText: "x",
		expectedRevision: "1",
	});
	assert.ok(finalized.status === "refused" && finalized.error.code === "access_denied");
	const removed = await removeAsset(p.brand, "mark", "1");
	assert.ok(!removed.ok && removed.error?.code === "access_denied");
	assert.equal(await suggestFor(p.brand, "mark"), null);
});

test("a stale revision is a conflict and the next try with the latest revision succeeds", async () => {
	const p = port();
	const stale = await uploadAsset(p.brand, { slot: "mark", file: logo(), altText: "Mark", revision: () => "0" });
	assert.ok(!stale.ok && stale.error?.code === "conflict");
	const latest = await kitOf(p);
	const again = await uploadAsset(p.brand, {
		slot: "mark",
		file: logo(),
		altText: "Mark",
		revision: () => latest.revision,
	});
	assert.ok(again.ok);
});

test("suggested colors change nothing until chosen, and a chosen color saves only on Save", async () => {
	const p = port();
	let kit = await kitOf(p);
	const up = await uploadAsset(p.brand, {
		slot: "full_logo",
		file: logo(),
		altText: "Logo",
		revision: () => kit.revision,
	});
	assert.ok(up.ok);
	if (up.ok) kit = up.kit;
	assert.ok(canSuggest("full_logo") && canSuggest("mark") && !canSuggest("cover_photo"));
	const suggestion = await suggestFor(p.brand, "full_logo");
	assert.equal(suggestion?.suggestedPrimary, "#2E7D32");
	// Nothing was applied: the stored kit and the form are unchanged, and the form's patch is empty.
	assert.equal((await kitOf(p)).primaryColor, kit.primaryColor);
	const saved = formOf(kit);
	assert.deepEqual(patchOf(saved, saved), {});
	// Choosing sets the draft only; the patch then carries the primary color and nothing else.
	const chosen = { ...saved, primaryColor: suggestion!.suggestedPrimary };
	assert.deepEqual(patchOf(chosen, saved), { primaryColor: "#2E7D32" });
	assert.equal((await kitOf(p)).primaryColor, kit.primaryColor);
});

test("the preview places stored assets from the theme and keeps the type fallback without them", async () => {
	const p = port();
	let kit = await kitOf(p);
	const none = themeOf("Harvest Point Church", formOf(kit), "formal/legal", kit.assets);
	assert.equal(none.layout.documentClass === "formal/legal" && none.layout.headerLogo, null);
	for (const [slot, alt] of [
		["full_logo", "Logo"],
		["mark", "Mark"],
		["cover_photo", "Cover"],
		["signature", "Sign"],
	] as const) {
		const up = await uploadAsset(p.brand, { slot, file: logo(), altText: alt, revision: () => kit.revision });
		assert.ok(up.ok);
		if (up.ok) kit = up.kit;
	}
	const layout = (c: Parameters<typeof themeOf>[2]) =>
		themeOf("Harvest Point Church", formOf(kit), c, kit.assets).layout;
	const formal = layout("formal/legal");
	assert.ok(
		formal.documentClass === "formal/legal" &&
			formal.headerLogo?.alt === "Logo" &&
			formal.signature.image?.alt === "Sign",
	);
	const outward = layout("outward-facing");
	assert.ok(
		outward.documentClass === "outward-facing" &&
			outward.coverLogo?.alt === "Logo" &&
			outward.coverPhoto?.alt === "Cover",
	);
	const operational = layout("operational");
	assert.ok(operational.documentClass === "operational" && operational.mark?.alt === "Mark");
	const email = layout("email");
	assert.ok(email.documentClass === "email" && email.headerLogo?.alt === "Logo" && email.logoMaxWidthPx === 200);
});

test("the brand swatch is the draft primary color, or neutral ink with a note", () => {
	const [light, dark, brand] = backgrounds("#1F4E79", "#1A1A1A");
	assert.equal(light!.color, "white");
	assert.notEqual(dark!.color, light!.color);
	assert.deepEqual([brand!.color, brand!.note], ["#1F4E79", undefined]);
	const neutral = backgrounds(null, "#1A1A1A")[2]!;
	assert.equal(neutral.color, "#1A1A1A");
	assert.match(neutral.note ?? "", /neutral ink/);
});
