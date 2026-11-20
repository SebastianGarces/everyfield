import type {
	OrganizationOperations,
	RelationshipPair,
	expiredInvitationResult,
	invitationResult,
	relationshipHistoryResult,
	relationshipProjection,
	sharingChoices,
	sharingDisclosure,
} from "@everyfield/contracts/organizations";
import type { z } from "zod";

type Ops = OrganizationOperations;
export type OperationName = keyof Ops;

export type Run = <K extends OperationName>(operation: K, input: Ops[K]["input"]) => Promise<Ops[K]["output"]>;

export type Relationship = z.infer<typeof relationshipProjection>;
export type Invitation = z.infer<typeof invitationResult>;
export type ExpiredInvitation = z.infer<typeof expiredInvitationResult>;
export type Disclosure = z.infer<typeof sharingDisclosure>;
export type Choices = z.infer<typeof sharingChoices>;
export type Category = keyof Choices;
export type History = Extract<z.infer<typeof relationshipHistoryResult>, { status: "available" }>;
export type HistoryItem = History["items"][number];
export type Organization = RelationshipPair["organization"];
export type { RelationshipPair };

export type NameOf = (
	endpoint: { kind: "account"; id: string } | { kind: "plant" | "organization"; id: string },
) => string;
