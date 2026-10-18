import "server-only";
export { currentActor } from "./session.ts";
export { accessPolicies, isAdministrator, plantAdministration, ordinarySeatAdministration } from "./policy.ts";
export type { OperationPolicy } from "./policy.ts";
export { readPipelinePerson, readOrganizationNotes, readOwnResidency } from "./pipeline.ts";
export { readPlantAffiliation, readDiscoveryRelationship, readPlatformGrant, checkPrivateCare } from "./grants.ts";
export { requestAdmission, safeReturn } from "./security.ts";
export type { RequestAdmission } from "./security.ts";
export { readProjection } from "./projection.ts";

import type { Transaction } from "@everyfield/db/client";
import type { AccessReader } from "@everyfield/contracts/access";
import { currentActor } from "./session.ts";
import { accessPolicies, type OperationPolicy } from "./policy.ts";
import { readPipelinePerson, readOrganizationNotes } from "./pipeline.ts";
export function accessReader(policies: readonly OperationPolicy[]): AccessReader<Transaction> {
  return { currentActor, ...accessPolicies(policies), readPipelinePerson, readOrganizationNotes };
}
