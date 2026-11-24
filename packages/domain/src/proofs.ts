import type {
	getAccountDeletionStatusRequest,
	getWorkspaceDeletionStatusRequest,
} from "@everyfield/contracts/settings/native";
import { createHash, randomBytes } from "node:crypto";
import "server-only";
import type { z } from "zod";
import { hash } from "./operations/canonical.ts";

type ProofKind = "invitation" | "connection" | "deletion";

let reveal: (proof: MintedProof<ProofKind>) => string;
export class MintedProof<Kind extends ProofKind> {
	readonly #value = randomBytes(32).toString("base64url");
	readonly kind: Kind;
	constructor(kind: Kind) {
		this.kind = kind;
	}
	static {
		reveal = (proof) => proof.#value;
	}
}
export const linkProofDigest = (proof: MintedProof<"invitation"> | MintedProof<"connection">) =>
	createHash("sha256").update(reveal(proof)).digest("hex");
export const deletionProofDigest = (proof: MintedProof<"deletion">) => hash(reveal(proof));

export function invitationLink(origin: string, proof: MintedProof<"invitation">) {
	const url = new URL("/invitation", origin);
	url.hash = new URLSearchParams({ proof: reveal(proof) }).toString();
	return url.href;
}
export const connectionLink = (origin: string, path: string, invitationId: string, proof: MintedProof<"connection">) =>
	`${origin}${path}?invitation=${invitationId}#${reveal(proof)}`;
export const deletionCookieValue = (
	proof: MintedProof<"deletion">,
	request: z.infer<typeof getAccountDeletionStatusRequest> | z.infer<typeof getWorkspaceDeletionStatusRequest>,
) => JSON.stringify({ handle: reveal(proof), request });
