import type {
	OrganizationOperations,
	RelationshipPair,
	invitationResult,
	relationshipHistoryResult,
	relationshipProjection,
	sharingChoices,
	sharingDisclosure,
} from "@everyfield/contracts/organizations";
import type { z } from "zod";

// The organization screens read and send only contract shapes. They never decide authority: the server re-checks
// every operation, and a hidden control is not a refusal (REQ-IDN-005, REQ-IDN-029).

type Ops = OrganizationOperations;
export type OperationName = keyof Ops;

/**
 * Runs one organization operation (WP-007/api). A thrown error means the reply did not arrive, so the outcome is
 * unknown: the screen keeps the same request key and lets the person try again (REQ-IDN-020 retries converge).
 */
export type Run = <K extends OperationName>(operation: K, input: Ops[K]["input"]) => Promise<Ops[K]["output"]>;

export type Relationship = z.infer<typeof relationshipProjection>;
export type Invitation = z.infer<typeof invitationResult>;
export type Disclosure = z.infer<typeof sharingDisclosure>;
export type Choices = z.infer<typeof sharingChoices>;
export type Category = keyof Choices;
export type History = Extract<z.infer<typeof relationshipHistoryResult>, { status: "available" }>;
export type HistoryItem = History["items"][number];
export type Organization = RelationshipPair["organization"];
export type { RelationshipPair };

/** The display name of a plant, organization or Discovery account. The contract carries IDs only. */
export type NameOf = (
	endpoint: { kind: "account"; id: string } | { kind: "plant" | "organization"; id: string },
) => string;

/** A new idempotency key for one intent. Keep it for every retry of that same intent. */
export function newRequestKey(intent: string): string {
	return `${intent}-${crypto.randomUUID()}`;
}
