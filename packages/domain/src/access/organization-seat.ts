import type { Owner } from "@everyfield/contracts/common";
import type { RequestActor } from "./session.ts";

type SeatContext = Extract<RequestActor["actor"]["context"], { kind: "seat" }>;
export type OrganizationSeatContext = SeatContext & { owner: Extract<Owner, { kind: "organization" }> };
export function organizationSeatContext(authority: RequestActor): OrganizationSeatContext | null {
	const context = authority.actor.context;
	return context.kind === "seat" && context.owner.kind === "organization" ? { ...context, owner: context.owner } : null;
}
