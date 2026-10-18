import type { PoolClient } from 'pg';
import type { OrganizationAdapter } from '@everyfield/contracts/organizations';
import type { OrganizationEffects } from './core.ts';
import type { GeographyReference } from './profile.ts';
import { relationshipCommands } from './relationships.ts';
import { sharingOperations } from './sharing.ts';
import { getHistory } from './history.ts';
import { consentOperations } from './consent.ts';
import { profileOperations } from './profile.ts';
// Native server adapter. Call inside one transaction; errors must roll it back.
// Required collaborators persist their intents on this exact connection. They
// cannot call providers here. Evry's reviewed admission remains its adapter's job.
export function createOrganizationAdapter(effects:OrganizationEffects,geography:GeographyReference):OrganizationAdapter<PoolClient> {
  return {...relationshipCommands(effects),...sharingOperations(effects),...consentOperations(effects),...profileOperations(effects,geography),'associations.getHistory':getHistory};
}
export type { OrganizationEffects, GeographyReference };
export { canReadSharedSources, canDispatchActivity } from './gates.ts';
export { canReadResidentProgress } from './consent.ts';
export { readSharingDisclosure } from './sharing.ts';
