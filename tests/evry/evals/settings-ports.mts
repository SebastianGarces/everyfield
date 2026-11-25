import { randomUUID } from "node:crypto";
import { sql, type SQLWrapper } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database, Transaction } from "../../../packages/db/src/client.ts";
import { createInvitationService } from "../../../packages/domain/src/identity/index.ts";
import type { InvitationMail } from "../../../packages/domain/src/identity/invitations.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { createOrganizationAdapter, geographyReference } from "../../../packages/domain/src/organizations/index.ts";
import { accountPersonProducer } from "../../../packages/domain/src/people/index.ts";
import {
	avatarOperations,
	deletionOperations,
	sectionOperations,
	timezoneOperations,
} from "../../../packages/domain/src/settings/index.ts";
import type { NativePorts } from "../../../packages/evry/src/index.ts";
import { createMailService, type MailIntent } from "../../../packages/domain/src/jobs/mail.ts";
import { enqueueJob, queueJobs } from "../../../packages/domain/src/jobs/queue.ts";

const queue = createMailService({
	db: null as never,
	encryptionKey: Buffer.alloc(32, 1),
	addressKey: Buffer.alloc(32, 2),
	from: "evry@example.test",
	authorize: async () => new Set(),
});
type Queued = Pick<MailIntent, "owner" | "purpose" | "logicalKey" | "address" | "operation">;
const queueInvitation = (tx: Transaction, writes: SQLWrapper[], mail: Queued) =>
	queue.append(
		tx,
		{
			...mail,
			recipient: null,
			content: { subject: "Your Everyfield invitation", text: "Synthetic invitation." },
			notice: null,
			eligibleAt: new Date().toISOString(),
		},
		writes,
	);

export function nativePorts(
	mail: { to: string; purpose: string }[] = [],
	{ queued = false }: { queued?: boolean } = {},
): NativePorts {
	const organizationEffects = {
		async invitation(
			tx: Transaction,
			input: { owner: MailIntent["owner"]; invitationId: string; operationId: string; recipientEmail: string },
			writes: SQLWrapper[],
		) {
			mail.push({ to: input.recipientEmail, purpose: "relationship_invitation" });
			if (queued)
				await queueInvitation(tx, writes, {
					owner: input.owner,
					purpose: "relationship_invitation",
					logicalKey: `relationship/${input.invitationId}/${input.operationId}`,
					address: input.recipientEmail,
					operation: input.operationId,
				});
		},
		invalidate: (_tx: unknown, input: { sourceId: string }) =>
			sql`UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=${input.sourceId} AND kind='digest' AND state IN ('ready','retry_wait','claimed')`,
	};
	const organizations = createOrganizationAdapter(organizationEffects as never, geographyReference);
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
				async enqueueMail(tx, m: InvitationMail, command) {
					mail.push({ to: m.recipientEmail, purpose: m.purpose });
					if (!queued) return randomUUID();
					return queueInvitation(tx, command.writes, {
						owner: m.owner,
						purpose: m.purpose,
						logicalKey: m.logicalKey,
						address: m.recipientEmail,
						operation: m.operationId,
					});
				},
			}),
		organizations,
		settings: {
			updatePlantProfile: sections.updatePlantProfile,
			setDigestSchedule: sections.setDigestSchedule,
			previewPlantTimezone: timezones.previewPlantTimezone,
			setPlantTimezone: timezones.setPlantTimezone,
		},
		account: { finalizeAvatar: avatar.finalizeAvatar, requestAccountDeletion: deletion.requestAccountDeletion },
		onboarding: createOnboardingProducer({
			relationships: async (_tx, inputs) => {
				for (const i of inputs) mail.push({ to: i.relationshipId, purpose: i.kind });
			},
			async enqueue(_tx, input) {
				mail.push({
					to: input.address,
					purpose: input.kind === "discovery_created" ? "discovery_receipt" : "notification",
				});
			},
		}),
		appVersion: null,
	};
}
