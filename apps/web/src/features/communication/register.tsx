"use client";

import {
	archiveTemplate,
	createTemplate,
	deleteDraft,
	deleteTemplate,
	forkTemplate,
	getDraft,
	listTemplates,
	preview,
	rescheduleReviewed,
	resolveAudience,
	saveDraft,
	scheduleReviewed,
	searchRecipients,
	updateTemplate,
} from "./actions";

const actions = [
	archiveTemplate,
	createTemplate,
	deleteDraft,
	deleteTemplate,
	forkTemplate,
	getDraft,
	listTemplates,
	preview,
	rescheduleReviewed,
	resolveAudience,
	saveDraft,
	scheduleReviewed,
	searchRecipients,
	updateTemplate,
];

/** Keeps the composition actions in the server-action manifest. This is not a product screen. */
export function CommunicationRegister() {
	return <span hidden>{actions.map((action) => action.name).join(" ")}</span>;
}
