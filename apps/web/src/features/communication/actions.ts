"use server";

import {
	communicationWriter,
	type CommunicationContext,
	type CommunicationReply,
} from "@everyfield/domain/communication";
import type { Transaction } from "@everyfield/db/client";
import type { AudienceSummary, Draft, Outcome, Preview, Recipient, Template } from "./model.ts";
import { canWrite, communicationViewer, read, write, type Viewer } from "./server.ts";

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

export async function scheduleReviewed(
	requestKey: string,
	expectedRevision: string,
	communicationId: string,
	scheduledAt: string,
): Promise<Outcome<Scheduled>> {
	return change((tx, context) =>
		communicationWriter.scheduleReviewed(tx, context, {
			requestKey,
			expectedRevision,
			input: { communicationId, scheduledAt },
		}),
	);
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

export async function previewMessage(input: unknown): Promise<Outcome<Preview>> {
	return look((tx, viewer) => communicationWriter.readPreview(tx, viewer.authority, input));
}

export async function resolveAudience(input: unknown): Promise<Outcome<AudienceSummary>> {
	return look((tx, viewer) => communicationWriter.readAudience(tx, viewer.authority, input));
}

export async function searchRecipients(query: string): Promise<Outcome<{ people: Recipient[] }>> {
	return look((tx, viewer) => communicationWriter.readRecipients(tx, viewer.authority, { query }));
}

/** Templates after a fork is archived, so the system original shows again. */
export async function reloadTemplates(): Promise<Outcome<Template[]>> {
	const viewer = await seat();
	if (!viewer) return denied;
	const result = await read(viewer, (tx) => communicationWriter.listTemplates(tx, viewer.authority));
	if (result.status !== "ok") return result;
	return { status: "ok", value: result.value.templates };
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

export async function archiveTemplate(
	requestKey: string,
	expectedRevision: string,
	templateId: string,
): Promise<Outcome<Template>> {
	return change((tx, context) =>
		communicationWriter.archiveTemplate(tx, context, {
			requestKey,
			expectedRevision,
			input: { templateId },
		}),
	);
}

export async function deleteTemplate(
	requestKey: string,
	expectedRevision: string,
	templateId: string,
): Promise<Outcome<Template>> {
	return change((tx, context) =>
		communicationWriter.deleteTemplate(tx, context, {
			requestKey,
			expectedRevision,
			input: { templateId },
		}),
	);
}
