"use server";

import {
	communicationWriter,
	type CommunicationContext,
	type CommunicationReply,
} from "@everyfield/domain/communication";
import { meetingsReader } from "@everyfield/domain/meetings";
import type { Transaction } from "@everyfield/db/client";
import type {
	AudienceSummary,
	CancelReport,
	DeliveryReport,
	DeliveryTotals,
	Draft,
	HistoryPage,
	MeetingHistory,
	MessageDetail,
	MeetingContext,
	MessageView,
	NamedRecipient,
	Outcome,
	PersonHistory,
	Recipient,
	ReplaceReport,
	RescheduleReport,
	ResendReview,
	RestoreReport,
	SavedResend,
	HandoffResult,
	SuppressionReport,
	Template,
	TrackingRow,
} from "./model.ts";
import { read as readMeeting } from "../meetings/server.ts";
import { canWrite } from "../../components/seat-role.ts";
import { communicationViewer, deliver, read, write, type Viewer } from "./server.ts";
import { chainHandoff, chainSendNow } from "./sendNowChain.ts";
import { anticipateProvider, appOrigin, deliveryTransport, mailReady } from "../../server/mail/transport.ts";

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
	when: "now" | "held" = "now",
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

export async function readDraft(communicationId: string): Promise<Outcome<Draft>> {
	return look((tx, viewer) => communicationWriter.get(tx, viewer.authority, { id: communicationId }));
}

export async function readOwnSuppression(): Promise<Outcome<SuppressionReport>> {
	const gate = await communicationViewer();
	if (!gate.viewer || !canWrite(gate.viewer)) return denied;
	const address = gate.email;
	if (!address) return denied;
	const result = await deliver((db, viewer, mail) =>
		communicationWriter.listForSelf(db, viewer.authority, { address }, mail.keys),
	);
	if (result.status !== "ok") return result;
	const { active, restores } = result.value;
	return { status: "ok", value: { address: result.value.address, active, restores } };
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

export async function readHistory(query: {
	limit?: unknown;
	cursor?: unknown;
	state?: unknown;
	channel?: unknown;
	meetingId?: unknown;
	personId?: unknown;
	query?: unknown;
}): Promise<Outcome<HistoryPage>> {
	const viewer = await seat();
	if (!viewer) return denied;
	return read(viewer, (tx) => communicationWriter.listHistory(tx, viewer.authority, query));
}

export async function readPersonHistory(personId: string, cursor?: string): Promise<Outcome<PersonHistory>> {
	const viewer = await seat();
	if (!viewer) return denied;
	return read(viewer, (tx) =>
		communicationWriter.listForPerson(tx, viewer.authority, {
			personId,
			limit: 50,
			...(cursor ? { cursor } : {}),
		}),
	);
}

export async function readMeetingHistory(meetingId: string, cursor?: string): Promise<Outcome<MeetingHistory>> {
	const viewer = await seat();
	if (!viewer) return denied;
	return read(viewer, (tx) =>
		communicationWriter.listForMeeting(tx, viewer.authority, {
			meetingId,
			limit: 50,
			...(cursor ? { cursor } : {}),
		}),
	);
}

export async function readMeetingTracking(meetingId: string): Promise<Outcome<{ items: TrackingRow[] }>> {
	const viewer = await seat();
	if (!viewer) return denied;
	return read(viewer, async (tx) => {
		const result = await communicationWriter.listMeetingTracking(tx, viewer.authority, { meetingId });
		if (result.status !== "ok") return result;
		return { status: "ok", value: { items: result.value.items } };
	});
}

export async function openMessage(communicationId: string): Promise<Outcome<MessageView>> {
	const viewer = await seat();
	if (!viewer) return denied;
	const keys = mailReady()?.keys;
	return read(viewer, async (tx) => {
		const detail = await communicationWriter.getDetail(tx, viewer.authority, { id: communicationId }, keys);
		if (detail.status !== "ok") return detail;
		const totals = await communicationWriter.getDeliveryTotals(tx, viewer.authority, { communicationId });
		if (totals.status !== "ok") return totals;
		const recipients = await communicationWriter.listHistoryRecipients(
			tx,
			viewer.authority,
			{ communicationId, limit: 100 },
			keys,
		);
		if (recipients.status !== "ok") return recipients;
		return {
			status: "ok",
			value: {
				detail: detail.value satisfies MessageDetail,
				totals: totals.value satisfies DeliveryTotals,
				recipients: recipients.value.items satisfies NamedRecipient[],
				recipientsComplete: recipients.value.complete,
			},
		};
	});
}

export async function reviewResend(communicationId: string): Promise<Outcome<ResendReview>> {
	return look(async (tx, viewer) => {
		const result = await communicationWriter.listResendCandidates(tx, viewer.authority, {
			communicationId,
			selection: "delivered_nonopeners",
		});
		if (result.status !== "ok") return result;
		return {
			status: "ok",
			value: {
				communicationId: result.value.communicationId,
				eligibleIds: result.value.eligibleIds,
				eligibleNames: result.value.eligibleNames,
				excludedNames: result.value.excludedNames,
				confirmedDelivery: result.value.confirmedDelivery,
			},
		};
	});
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

export async function handOff(
	keys: { save: string; schedule: string; send: string },
	expectedRevision: string | null,
	target: { kind: "draft"; input: unknown } | { kind: "reviewed"; communicationId: string },
	scheduledAt: string | null,
): Promise<Outcome<HandoffResult>> {
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

export async function readMeetingContext(meetingId: string): Promise<Outcome<MeetingContext>> {
	const viewer = await seat();
	if (!viewer || !canWrite(viewer)) return denied;
	const context = await readMeeting(viewer, (db, a) => meetingsReader.communicationContext(db, a, { meetingId }));
	if (context.status === "failed") return { status: "lost" };
	if (context.status === "refused") return { status: "refused", code: "not_found" };
	const { meeting: m, guests } = context.value;
	return {
		status: "ok",
		value: {
			id: m.id,
			type: m.type,
			title: m.displayTitle,
			date: m.localDate,
			time: m.localTime,
			place: m.venue?.name ?? null,
			guests: guests.map((g) => ({ id: g.personId, displayName: g.displayName })),
		},
	};
}

export async function readPreviewContext(): Promise<Outcome<{ churchName: string; origin: string }>> {
	const viewer = await seat();
	if (!viewer) return denied;
	const origin = appOrigin();
	if (origin === null) return { status: "refused", code: "unavailable" };
	return read(viewer, async (tx) => {
		const church = await communicationWriter.readChurchName(tx, viewer.authority);
		if (church.status !== "ok") return church;
		return { status: "ok", value: { churchName: church.value.churchName, origin } };
	});
}
