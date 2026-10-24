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
} from "@/features/communication/actions";
import { getViewer } from "@/server/request-context";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// The statement census reads these action ids from the production build. This route renders no screen.
const censusActions = [
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

export default async function CommunicationPage() {
	const viewer = await getViewer();
	if (!viewer || viewer.status === "unauthenticated") redirect("/signin?returnTo=%2Fcommunication");
	if (censusActions.length !== 14) redirect("/signin");
	return null;
}
