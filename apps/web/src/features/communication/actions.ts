"use server";

import {
	communicationWriter,
	type CommunicationContext,
	type CommunicationReply,
} from "@everyfield/domain/communication";
import type { Transaction } from "@everyfield/db/client";
import type {
	AudienceSummary,
	CancelReport,
	DeliveryReport,
	Draft,
	Outcome,
	Preview,
	Recipient,
	ReplaceReport,
	RescheduleReport,
	RestoreReport,
	SuppressionReport,
	Template,
} from "./model.ts";
import { canWrite, communicationViewer, deliver, read, write, type Viewer } from "./server.ts";
import { deliveryTransport } from "./mail.ts";

// Server actions for the Messages screens. The actor is the request's seat. The browser cannot send one.
// A lost write keeps its request key so a retry replays. The caller mints a new key after success or a refusal.

type Scheduled = Draft & { scheduledAt: string };
const denied = { status: "refused", code: "access_denied" } as const;

async function seat(): Promise<Viewer | null> {
	const gate = await communicationViewer();
	return gate.viewer;
}

async function change<T>(
	run: (tx: Transaction, context: CommunicationContext) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	const viewer = await seat();
	if (!viewer || !canWrite(viewer)) return denied;
	return write(viewer, run);
}

async function look<T>(run: (tx: Transaction, viewer: Viewer) => Promise<CommunicationReply<T>>): Promise<Outcome<T>> {
	const viewer = await seat();
	if (!viewer || !canWrite(viewer)) return denied;
	return read(viewer, (tx) => run(tx, viewer));
}

export async function saveDraft(
	requestKey: string,
	expectedRevision: string | null,
	input: unknown,
): Promise<Outcome<Draft>> {
	return change((tx, context) =>
		communicationWriter.saveDraft(tx, context, {
			requestKey,
			...(expectedRevision ? { expectedRevision } : {}),
			input,
		}),
	);
}

export async function deleteDraft(
	requestKey: string,
	expectedRevision: string,
	communicationId: string,
): Promise<Outcome<Draft>> {
	return change((tx, context) =>
		communicationWriter.deleteDraft(tx, context, {
			requestKey,
			expectedRevision,
			input: { communicationId },
		}),
	);
}

/** Save and schedule in one request. Two requests were the schedule that passed one second. */
export async function scheduleDraft(
	saveKey: string,
	scheduleKey: string,
	expectedRevision: string | null,
	input: unknown,
	scheduledAt: string,
): Promise<Outcome<Scheduled>> {
	return change(async (tx, context) => {
		const saved = await communicationWriter.saveDraft(tx, context, {
			requestKey: saveKey,
			...(expectedRevision ? { expectedRevision } : {}),
			input,
		});
		if (saved.status !== "ok") return saved;
		return communicationWriter.scheduleReviewed(tx, context, {
			requestKey: scheduleKey,
			expectedRevision: saved.value.revision,
			input: { communicationId: saved.value.communicationId, scheduledAt },
		});
	});
}

export async function rescheduleReviewed(
	requestKey: string,
	expectedRevision: string,
	communicationId: string,
	scheduledAt: string,
): Promise<Outcome<Scheduled>> {
	return change((tx, context) =>
		communicationWriter.rescheduleReviewed(tx, context, {
			requestKey,
			expectedRevision,
			input: { communicationId, scheduledAt },
		}),
	);
}

/** Hand a scheduled email to the provider now. The provider key is the domain idempotency key. */
export async function sendReviewed(
	requestKey: string,
	expectedRevision: string,
	communicationId: string,
): Promise<Outcome<DeliveryReport>> {
	const result = await deliver((db, viewer, mail) =>
		communicationWriter.sendReviewed(
			db,
			viewer.authority,
			{ requestKey, expectedRevision, input: { communicationId } },
			deliveryTransport(mail),
			mail.keys,
		),
	);
	if (result.status !== "ok") return result;
	return {
		status: "ok",
		value: {
			status: result.value.status,
			acceptedCount: result.value.acceptedCount,
			rejectedCount: result.value.rejectedCount,
			unknownCount: result.value.unknownCount,
		},
	};
}

/** Ask the provider about a send that already exists. A missing send is not_found. */
export async function reconcileDelivery(
	requestKey: string,
	expectedRevision: string,
	communicationId: string,
): Promise<Outcome<DeliveryReport>> {
	const result = await deliver((db, viewer, mail) =>
		communicationWriter.reconcileProviderOutcome(
			db,
			viewer.authority,
			{ requestKey, expectedRevision, input: { communicationId } },
			deliveryTransport(mail),
			mail.keys,
		),
	);
	if (result.status !== "ok") return result;
	return {
		status: "ok",
		value: {
			status: result.value.status,
			acceptedCount: result.value.acceptedCount,
			rejectedCount: result.value.rejectedCount,
			unknownCount: result.value.unknownCount,
		},
	};
}

/** Request cancellation. The domain id is not a provider email id, so confirmation can stay unknown. */
export async function cancelScheduled(
	requestKey: string,
	expectedRevision: string,
	communicationId: string,
): Promise<Outcome<CancelReport>> {
	const result = await deliver((db, viewer, mail) =>
		communicationWriter.cancelScheduledReviewed(
			db,
			viewer.authority,
			{ requestKey, expectedRevision, input: { communicationId } },
			deliveryTransport(mail),
		),
	);
	if (result.status !== "ok") return result;
	return { status: "ok", value: { scheduledCancel: result.value.scheduledCancel } };
}

/** Read whether every previous send is cancelled. This does not create or send a message. */
export async function replaceScheduled(
	requestKey: string,
	expectedRevision: string,
	communicationId: string,
): Promise<Outcome<ReplaceReport>> {
	const result = await deliver((db, viewer) =>
		communicationWriter.replaceScheduledReviewed(db, viewer.authority, {
			requestKey,
			expectedRevision,
			input: { communicationId },
		}),
	);
	if (result.status !== "ok") return result;
	return { status: "ok", value: { replacementAllowed: result.value.replacementAllowed } };
}

/** Change the send time and ask the provider when a provider key exists. The new revision comes from readDraft. */
export async function rescheduleDispatched(
	requestKey: string,
	expectedRevision: string,
	communicationId: string,
	scheduledAt: string,
): Promise<Outcome<RescheduleReport>> {
	const result = await deliver((db, viewer, mail) =>
		communicationWriter.rescheduleDispatched(
			db,
			viewer.authority,
			{ requestKey, expectedRevision, input: { communicationId, scheduledAt } },
			deliveryTransport(mail),
		),
	);
	if (result.status !== "ok") return result;
	return {
		status: "ok",
		value: { rescheduleStatus: result.value.rescheduleStatus, scheduledAt: result.value.scheduledAt },
	};
}

export async function readDraft(communicationId: string): Promise<Outcome<Draft>> {
	return look((tx, viewer) => communicationWriter.get(tx, viewer.authority, { id: communicationId }));
}

/** The address is the signed-in account email. The browser cannot choose a different one. */
export async function readOwnSuppression(): Promise<Outcome<SuppressionReport>> {
	const gate = await communicationViewer();
	if (!gate.viewer || !canWrite(gate.viewer)) return denied;
	const address = gate.email;
	if (!address) return denied;
	const result = await deliver((db, viewer, mail) =>
		communicationWriter.listForSelf(db, viewer.authority, { address }, mail.keys),
	);
	if (result.status !== "ok") return result;
	return { status: "ok", value: { address: result.value.address, active: result.value.active } };
}

/** Clear suppression for the signed-in account email. This does not send email. */
export async function restoreOwnSuppression(requestKey: string, reason: string): Promise<Outcome<RestoreReport>> {
	const gate = await communicationViewer();
	if (!gate.viewer || !canWrite(gate.viewer)) return denied;
	const address = gate.email;
	if (!address) return denied;
	const result = await deliver((db, viewer, mail) =>
		communicationWriter.requestRestore(db, viewer.authority, { requestKey, input: { address, reason } }, mail.keys),
	);
	if (result.status !== "ok") return result;
	return { status: "ok", value: { suppressionClears: result.value.suppressionClears } };
}

export async function previewMessage(input: unknown): Promise<Outcome<Preview>> {
	return look((tx, viewer) => communicationWriter.readPreview(tx, viewer.authority, input));
}

export async function resolveAudience(input: unknown): Promise<Outcome<AudienceSummary>> {
	return look((tx, viewer) => communicationWriter.readAudience(tx, viewer.authority, input));
}

export async function searchRecipients(query: string): Promise<Outcome<{ people: Recipient[] }>> {
	return look((tx, viewer) => communicationWriter.readRecipients(tx, viewer.authority, { query }));
}

export async function readMeetingTemplate(meetingType: string): Promise<Outcome<Template>> {
	return look((tx, viewer) => communicationWriter.readMeetingTemplate(tx, viewer.authority, { meetingType }));
}

export async function createTemplate(requestKey: string, input: unknown): Promise<Outcome<Template>> {
	return change((tx, context) => communicationWriter.createTemplate(tx, context, { requestKey, input }));
}

export async function forkTemplate(requestKey: string, sourceKey: string): Promise<Outcome<Template>> {
	return change((tx, context) => communicationWriter.forkTemplate(tx, context, { requestKey, input: { sourceKey } }));
}

export async function updateTemplate(
	requestKey: string,
	expectedRevision: string,
	templateId: string,
	patch: unknown,
): Promise<Outcome<Template>> {
	return change((tx, context) =>
		communicationWriter.updateTemplate(tx, context, {
			requestKey,
			expectedRevision,
			input: { templateId, patch },
		}),
	);
}

type TemplateChange = { template: Template; templates: Template[] | null };

/** One request removes the row and, for a fork, returns the list with the system template restored. */
async function removeTemplate(
	kind: "archive" | "delete",
	requestKey: string,
	expectedRevision: string,
	templateId: string,
): Promise<Outcome<TemplateChange>> {
	const viewer = await seat();
	if (!viewer || !canWrite(viewer)) return denied;
	return write(viewer, async (tx, context): Promise<CommunicationReply<TemplateChange>> => {
		const removed =
			kind === "delete"
				? await communicationWriter.deleteTemplate(tx, context, {
						requestKey,
						expectedRevision,
						input: { templateId },
					})
				: await communicationWriter.archiveTemplate(tx, context, {
						requestKey,
						expectedRevision,
						input: { templateId },
					});
		if (removed.status !== "ok") return removed;
		if (!removed.value.sourceKey) return { status: "ok", value: { template: removed.value, templates: null } };
		const again = await communicationWriter.listTemplates(tx, viewer.authority);
		if (again.status !== "ok") return again;
		return { status: "ok", value: { template: removed.value, templates: again.value.templates } };
	});
}

export async function archiveTemplate(
	requestKey: string,
	expectedRevision: string,
	templateId: string,
): Promise<Outcome<TemplateChange>> {
	return removeTemplate("archive", requestKey, expectedRevision, templateId);
}

export async function deleteTemplate(
	requestKey: string,
	expectedRevision: string,
	templateId: string,
): Promise<Outcome<TemplateChange>> {
	return removeTemplate("delete", requestKey, expectedRevision, templateId);
}
