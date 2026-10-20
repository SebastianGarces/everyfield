import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import type { Transaction } from "@everyfield/db/client";
import { consentOperations } from "./consent.ts";
import type { OrganizationEffects } from "./core.ts";
import { getHistory } from "./history.ts";
import type { GeographyReference } from "./profile.ts";
import { profileOperations } from "./profile.ts";
import { relationshipCommands } from "./relationships.ts";
import { sharingOperations } from "./sharing.ts";
// Native server adapter. Call inside one transaction; errors must roll it back.
// Required collaborators persist their intents on this exact connection. They
// cannot call providers here. Evry's reviewed admission remains its adapter's job.
export function createOrganizationAdapter(
	effects: OrganizationEffects,
	geography: GeographyReference,
): OrganizationAdapter<Transaction> {
	return {
		...relationshipCommands(effects),
		...sharingOperations(effects),
		...consentOperations(effects),
		...profileOperations(effects, geography),
		"associations.getHistory": getHistory,
	};
}
export { readAnswerableInvitation } from "./relationships.ts";
export { readSharingDisclosure } from "./sharing.ts";
export type { GeographyReference, OrganizationEffects };

export {
	connectionRevision,
	idsIn,
	namesFor,
	pairOf,
	pendingFor,
	residencyLinks,
	residencyRevision,
	subjectFacts,
	targetsFor,
} from "./reads.ts";
export type { Kind, Viewer } from "./reads.ts";
