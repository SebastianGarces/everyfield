"use server";

import {
	communicationWriter,
	type CommunicationContext,
	type CommunicationReply,
} from "@everyfield/domain/communication";
import { z } from "zod";
import type {
	AudienceSummary,
	CancelReport,
	DeliveryReport,
	Draft,
	Outcome,
	ReplaceReport,
	RescheduleReport,
	RestoreReport,
	SavedResend,
	HandoffResult,
	Template,
} from "./model.ts";
import { canWrite } from "../../components/seat-role.ts";
import { communicationViewer, deliver, read, write, type Viewer } from "./server.ts";
import { chainHandoff, chainSendNow } from "./sendNowChain.ts";
import { anticipateProvider, deliveryTransport } from "../../server/mail/transport.ts";
import type { WriteTx } from "@everyfield/domain/access";

type Scheduled = Draft & { scheduledAt: string };
const denied = { status: "refused", code: "access_denied" } as const;

async function seat(): Promise<Viewer | null> {
	const gate = await communicationViewer();
	return gate.viewer;
}

async function change<T>(
	run: (tx: WriteTx, context: CommunicationContext) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	const viewer = await seat();
	if (!viewer || !canWrite(viewer)) return denied;
	return write(viewer, run);
}

async function look<T>(run: (tx: WriteTx, viewer: Viewer) => Promise<CommunicationReply<T>>): Promise<Outcome<T>> {
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

async function scheduleDraft(
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

export async function sendReviewed(
	requestKey: string,
	expectedRevision: string,
	communicationId: string,
	when: unknown = "now",
): Promise<Outcome<DeliveryReport>> {
	const result = await deliver((db, viewer, mail) => {
		anticipateProvider(mail);
		const handOff = when === "now" ? communicationWriter.sendReviewed : communicationWriter.handOffScheduled;
		return handOff(
			db,
			viewer.authority,
			{ requestKey, expectedRevision, input: { communicationId } },
			deliveryTransport(mail),
			mail.keys,
		);
	});
	if (result.status !== "ok") return result;
	return {
		status: "ok",
		value: {
			status: result.value.status,
			acceptedCount: result.value.acceptedCount,
			rejectedCount: result.value.rejectedCount,
			unknownCount: result.value.unknownCount,
			unsubscribedCount: result.value.unsubscribedCount,
		},
	};
}

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
			unsubscribedCount: result.value.unsubscribedCount,
		},
	};
}

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
	const { scheduledCancel, confirmedCount, sentCount, openCount } = result.value;
	return { status: "ok", value: { scheduledCancel, confirmedCount, sentCount, openCount } };
}

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
	const { rescheduleStatus, heldAt, confirmedCount, sentCount, openCount } = result.value;
	return {
		status: "ok",
		value: { rescheduleStatus, scheduledAt: result.value.scheduledAt, heldAt, confirmedCount, sentCount, openCount },
	};
}

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

export async function resolveAudience(input: unknown): Promise<Outcome<AudienceSummary>> {
	return look((tx, viewer) => communicationWriter.readAudience(tx, viewer.authority, input));
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

export async function saveResend(requestKey: string, communicationId: string): Promise<Outcome<SavedResend>> {
	return change(async (tx, context) => {
		const result = await communicationWriter.executeResend(tx, context, {
			requestKey,
			input: { communicationId, selection: "delivered_nonopeners" },
		});
		if (result.status !== "ok") return result;
		return {
			status: "ok",
			value: {
				communicationId: result.value.communicationId,
				eligibleIds: result.value.eligibleIds,
				eligibleNames: result.value.eligibleNames,
			},
		};
	});
}

async function scheduleExisting(
	requestKey: string,
	expectedRevision: string,
	communicationId: string,
	scheduledAt: string,
): Promise<Outcome<Draft & { scheduledAt: string }>> {
	return change(async (tx, context) => {
		const result = await communicationWriter.scheduleReviewed(tx, context, {
			requestKey,
			expectedRevision,
			input: { communicationId, scheduledAt },
		});
		if (result.status !== "ok") return result;
		const value = result.value;
		return {
			status: "ok",
			value: {
				communicationId: value.communicationId,
				revision: value.revision,
				state: value.state,
				subject: value.subject,
				bodyHtml: value.bodyHtml,
				bodyText: value.bodyText,
				audience: value.audience,
				meetingId: value.meetingId,
				templateId: value.templateId,
				templateSource: value.templateSource,
				scheduledAt: value.scheduledAt,
			},
		};
	});
}

const handOffKeys = z.object({ save: z.string(), schedule: z.string(), send: z.string() });
const handOffTarget = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("draft"), input: z.unknown() }),
	z.object({ kind: z.literal("reviewed"), communicationId: z.string() }),
]);

export async function handOff(
	rawKeys: unknown,
	expectedRevision: string | null,
	rawTarget: unknown,
	scheduledAt: string | null,
): Promise<Outcome<HandoffResult>> {
	const parsedKeys = handOffKeys.safeParse(rawKeys);
	const parsedTarget = handOffTarget.safeParse(rawTarget);
	if (!parsedKeys.success || !parsedTarget.success) return { status: "refused", code: "invalid_input" };
	const keys = parsedKeys.data;
	const target = parsedTarget.data;
	const steps = {
		schedule: (at: string) =>
			target.kind === "draft"
				? scheduleDraft(keys.save, keys.schedule, expectedRevision, target.input, at)
				: scheduleExisting(keys.schedule, expectedRevision ?? "", target.communicationId, at),
		handOff: (revision: string, communicationId: string) =>
			sendReviewed(keys.send, revision, communicationId, scheduledAt === null ? "now" : "held"),
	};
	return scheduledAt === null ? chainSendNow(steps) : chainHandoff(steps, scheduledAt);
}
