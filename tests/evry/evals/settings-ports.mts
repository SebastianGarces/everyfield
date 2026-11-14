// The native services Evry's seat, Settings, sharing, connection, account and organization tools call, built the way
// the web app's mounts build them (apps/web/src/server/evry/native.ts), for tests: the email outbox is a list, and
// replan, cleanup and purge jobs go to the real queue.
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { createInvitationService } from "../../../packages/domain/src/identity/index.ts";
import type { InvitationMail } from "../../../packages/domain/src/identity/invitations.ts";
import { createOrganizationAdapter } from "../../../packages/domain/src/organizations/index.ts";
import { accountPersonProducer } from "../../../packages/domain/src/people/index.ts";
import {
	avatarOperations,
	deletionOperations,
	sectionOperations,
	timezoneOperations,
} from "../../../packages/domain/src/settings/index.ts";
import type { NativePorts } from "../../../packages/evry/src/index.ts";
import { enqueueJob, queueJobs } from "../../../apps/web/src/server/jobs/queue.ts";

/** The native services; every email they queue is pushed to `mail`. */
export function nativePorts(mail: { to: string; purpose: string }[] = []): NativePorts {
	const organizationEffects = {
		async invitation(_tx: unknown, input: { recipientEmail: string }) {
			mail.push({ to: input.recipientEmail, purpose: "relationship_invitation" });
		},
		// As the web app's organization mount: ending or changing a link stops queued digest work that read the old grant.
		invalidate: (_tx: unknown, input: { sourceId: string }) =>
			sql`UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=${input.sourceId} AND kind='digest' AND state IN ('ready','retry_wait','claimed')`,
	};
	const organizations = createOrganizationAdapter(organizationEffects as never, { candidates: async () => [] });
	const effects = {
		replan: (tx: never, i: { owner: { id: string }; revision: string; operationId: string; kind: string }) =>
			enqueueJob(tx, {
				tenant: i.owner.id,
				kind: "digest",
				subject: i.owner.id,
				key: `settings/${i.kind}/${i.operationId}`,
				revision: i.revision,
				eligibleAt: new Date().toISOString(),
			}),
	};
	const sections = sectionOperations({
		organizations,
		organizationEffects: organizationEffects as never,
		effects,
		suppression: async () => "clear",
	});
	const timezones = timezoneOperations(effects);
	// The cleanup and purge jobs go to the real queue, as the Settings mount queues them.
	const avatar = avatarOperations({
		queue: (tx, i) =>
			queueJobs(tx as never, [
				{
					tenant: i.accountId,
					kind: "object_cleanup",
					subject: i.fileId,
					key: `avatar/${i.fileId}/${i.eligibleAt}`,
					revision: "1",
					eligibleAt: i.eligibleAt,
				},
			]),
	});
	const deletion = deletionOperations({
		workspaceNotice: async () => {},
		queue: (tx, i) =>
			queueJobs(tx as never, [
				{
					tenant: i.subject.id,
					kind: "lifecycle_purge",
					subject: i.witnessId,
					key: `purge/${i.requestId}`,
					revision: i.revision,
					eligibleAt: i.eligibleAt,
				},
			]),
	});
	return {
		invitations: (on) =>
			createInvitationService({
				db: on as Database,
				origin: "https://evry.example.test",
				budgetSecret: "settings-evals",
				people: accountPersonProducer,
				addressBlocked: () => sql`false`,
				async enqueueMail(_tx, m: InvitationMail) {
					mail.push({ to: m.recipientEmail, purpose: m.purpose });
					return randomUUID();
				},
			}),
		organizations,
		settings: {
			updatePlantProfile: sections.updatePlantProfile,
			previewPlantTimezone: timezones.previewPlantTimezone,
			setPlantTimezone: timezones.setPlantTimezone,
		},
		account: { finalizeAvatar: avatar.finalizeAvatar, requestAccountDeletion: deletion.requestAccountDeletion },
	};
}
