import { z } from "zod";
import { personId, recordId, revision, operationId } from "../common/values.ts";
import { instant } from "../common/time.ts";
import { actorAttribution } from "./results.ts";
import { organizationOwner, contactFields } from "./values.ts";

// IDs and explicit category decisions only. No account-private originals,
// staff notes, reasons, feedback or saved source URLs can cross this boundary.
export const organizationExport = z.strictObject({ organization: organizationOwner, personId,
  sourceRevision: revision, consentRevision: revision.nullable(), producedAt: instant,
  contact: z.strictObject(contactFields),
  stageHistory: z.array(z.strictObject({ stageId: recordId, label: z.string().max(255), occurredAt: instant, actor: actorAttribution })).max(1000),
  programs: z.array(z.strictObject({ programId: recordId, status: z.enum(["active", "completed", "ended"]) })).max(1000),
  completions: z.array(z.strictObject({ milestoneId: recordId, completedAt: instant,
    source: z.enum(["resident", "program_leader_recorded"]), recordedBy: actorAttribution,
    confirmation: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("pending") }),
      z.strictObject({ status: z.literal("confirmed"), at: instant, by: actorAttribution }),
    ]) })).max(1000),
});
export const removalWitness = z.strictObject({ organization: organizationOwner,
  personRecordId: personId, removedAt: instant, revision: revision.refine(v => v !== "0"), checkpoint: revision.refine(v => v !== "0") });
export const removalResult = z.strictObject({ witness: removalWitness, receiptId: operationId,
  retained: z.array(z.strictObject({ category: z.enum(["enrollment", "program_completion", "relationship_receipt"]),
    reason: z.enum(["independent_organization_fact", "revocation_enforcement"]),
    attribution: z.literal("scope_local") })).max(3),
});
export type OrganizationExport = z.infer<typeof organizationExport>;
export type RemovalResult = z.infer<typeof removalResult>;
