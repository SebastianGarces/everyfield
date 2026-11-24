import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { inspect } from "node:util";
import {
	connectionLink,
	deletionCookieValue,
	deletionProofDigest,
	invitationLink,
	linkProofDigest,
	MintedProof,
} from "../../../packages/domain/src/proofs.ts";
import { getAccountDeletionStatusRequest } from "../../../packages/contracts/src/settings/native.ts";

const origin = "https://everyfield.test";
const id = "11111111-1111-4111-8111-111111111111";
const request = getAccountDeletionStatusRequest.parse({ subject: { kind: "account", id }, requestId: id });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function hides(proof: MintedProof<"invitation" | "connection" | "deletion">, raw: string) {
	assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
	const shown = [
		String(proof),
		`${proof}`,
		JSON.stringify(proof),
		JSON.stringify({ proof }),
		inspect(proof, { showHidden: true, depth: null }),
	];
	for (const text of shown) assert.ok(!text.includes(raw), "proof text leaked");
}

test("a minted invitation proof shows its value only in its link", () => {
	const proof = new MintedProof("invitation");
	const raw = invitationLink(origin, proof).split("/invitation#proof=")[1]!;
	hides(proof, raw);
	assert.equal(linkProofDigest(proof), sha256(raw));
});

test("a minted connection proof shows its value only in its link", () => {
	const proof = new MintedProof("connection");
	const link = connectionLink(origin, "/connections/respond", id, proof);
	const raw = link.split("#")[1]!;
	assert.equal(link, `${origin}/connections/respond?invitation=${id}#${raw}`);
	hides(proof, raw);
	assert.equal(linkProofDigest(proof), sha256(raw));
});

test("a minted deletion proof shows its value only in its cookie value", () => {
	const proof = new MintedProof("deletion");
	const value = deletionCookieValue(proof, request);
	const raw = JSON.parse(value).handle;
	assert.equal(value, JSON.stringify({ handle: raw, request }));
	hides(proof, raw);
	assert.equal(deletionProofDigest(proof), sha256(JSON.stringify(raw)));
});
