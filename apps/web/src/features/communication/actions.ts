"use server";

import { boundary, communicationWriter, read, write } from "./server.ts";

export async function saveDraft(requestKey: string, input: unknown) {
	return boundary((viewer) =>
		write(viewer, (tx, context) => communicationWriter.saveDraft(tx, context, { requestKey, input })),
	);
}

export async function deleteDraft(requestKey: string, expectedRevision: string, communicationId: string) {
	return boundary((viewer) =>
		write(viewer, (tx, context) =>
			communicationWriter.deleteDraft(tx, context, {
				requestKey,
				expectedRevision,
				input: { communicationId },
			}),
		),
	);
}

export async function scheduleReviewed(
	requestKey: string,
	expectedRevision: string,
	communicationId: string,
	scheduledAt: string,
) {
	return boundary((viewer) =>
		write(viewer, (tx, context) =>
			communicationWriter.scheduleReviewed(tx, context, {
				requestKey,
				expectedRevision,
				input: { communicationId, scheduledAt },
			}),
		),
	);
}

export async function rescheduleReviewed(
	requestKey: string,
	expectedRevision: string,
	communicationId: string,
	scheduledAt: string,
) {
	return boundary((viewer) =>
		write(viewer, (tx, context) =>
			communicationWriter.rescheduleReviewed(tx, context, {
				requestKey,
				expectedRevision,
				input: { communicationId, scheduledAt },
			}),
		),
	);
}

export async function createTemplate(requestKey: string, input: unknown) {
	return boundary((viewer) =>
		write(viewer, (tx, context) => communicationWriter.createTemplate(tx, context, { requestKey, input })),
	);
}

export async function forkTemplate(requestKey: string, sourceKey: string) {
	return boundary((viewer) =>
		write(viewer, (tx, context) => communicationWriter.forkTemplate(tx, context, { requestKey, input: { sourceKey } })),
	);
}

export async function updateTemplate(requestKey: string, expectedRevision: string, templateId: string, patch: unknown) {
	return boundary((viewer) =>
		write(viewer, (tx, context) =>
			communicationWriter.updateTemplate(tx, context, {
				requestKey,
				expectedRevision,
				input: { templateId, patch },
			}),
		),
	);
}

export async function archiveTemplate(requestKey: string, expectedRevision: string, templateId: string) {
	return boundary((viewer) =>
		write(viewer, (tx, context) =>
			communicationWriter.archiveTemplate(tx, context, {
				requestKey,
				expectedRevision,
				input: { templateId },
			}),
		),
	);
}

export async function deleteTemplate(requestKey: string, expectedRevision: string, templateId: string) {
	return boundary((viewer) =>
		write(viewer, (tx, context) =>
			communicationWriter.deleteTemplate(tx, context, {
				requestKey,
				expectedRevision,
				input: { templateId },
			}),
		),
	);
}

export async function preview(input: unknown) {
	return boundary((viewer) => read(viewer, (tx) => communicationWriter.readPreview(tx, viewer.authority, input)));
}

export async function searchRecipients(query: string) {
	return boundary((viewer) =>
		read(viewer, (tx) => communicationWriter.readRecipients(tx, viewer.authority, { query })),
	);
}

export async function resolveAudience(audience: unknown) {
	return boundary((viewer) => read(viewer, (tx) => communicationWriter.readAudience(tx, viewer.authority, audience)));
}

export async function listTemplates() {
	return boundary((viewer) => read(viewer, (tx) => communicationWriter.listTemplates(tx, viewer.authority)));
}

export async function getDraft(communicationId: string) {
	return boundary((viewer) =>
		read(viewer, (tx) => communicationWriter.getDraft(tx, viewer.authority, { id: communicationId })),
	);
}
