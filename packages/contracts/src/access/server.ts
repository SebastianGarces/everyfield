import type { z } from "zod";
import type { Owner, sessionId } from "../common/values.ts";
import type { SharedOperationCheckRequest, OrganizationPersonRequest, organizationNotesRequest } from "./requests.ts";
import type {
	CurrentActorResult,
	OperationCheckResult,
	PipelineAccessResult,
	OrganizationNotesResult,
} from "./results.ts";

// Implement in the server-only DAL. The caller supplies the transaction and a
// validated native/assistant session handle, not a hydrated actor/role snapshot.
// Each method re-reads session, active account, exact current membership, subject
// lifecycle and operation-specific grants/consent within this same transaction.
// Missing or inconsistent facts fail closed. Account identity, one seat, exact
// Discovery/residency links, affiliations and platform allowlists are independent.
// A platform capability never supplies tenant or original-author private access.
// Resolve the named operation from its producer registry; a request's read/write
// tag is not evidence of its kind. Routine administration is equal for accepted
// same-tenant Owner/Admin; workspace deletion still requires the actual Owner.
export interface AccessReader<Tx> {
	currentActor(tx: Tx, session: z.infer<typeof sessionId>, selected: Owner): Promise<CurrentActorResult>;
	checkOperation(
		tx: Tx,
		session: z.infer<typeof sessionId>,
		selected: Owner,
		input: SharedOperationCheckRequest,
	): Promise<OperationCheckResult>;
	readPipelinePerson(
		tx: Tx,
		session: z.infer<typeof sessionId>,
		selected: Owner,
		input: OrganizationPersonRequest,
	): Promise<PipelineAccessResult>;
	readOrganizationNotes(
		tx: Tx,
		session: z.infer<typeof sessionId>,
		selected: Owner,
		input: z.infer<typeof organizationNotesRequest>,
	): Promise<OrganizationNotesResult>;
}

// Registered jobs and exact proofs have their own producer-authenticated
// principals, never a fabricated human session or a client-selected actor ID.
// Origin checks, signed callbacks and sealed capabilities remain the platform
// adapters' admission responsibility. Admission never supplies domain authority.
