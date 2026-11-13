import type { WorkspaceDeletionNotice } from "@everyfield/domain/settings";

// The church workspace deletion notices (T-272): one email per open seat, rendered from the request's own facts. No
// copy carries a sign-in token, a signed URL or a link into church pages.

/** The stored cancel deadline in one zone, to the minute, with the zone named: "December 12, 2026 at 3:04 PM (UTC)". */
export function deadline(at: string, timeZone: string) {
	const text = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short", timeZone }).format(
		new Date(at),
	);
	return `${text} (${timeZone})`;
}

/**
 * The subject and text for one recipient. The deadline is in the recipient's personal time zone, or the church's when
 * they have not set one.
 */
export function workspaceDeletionContent(
	notice: WorkspaceDeletionNotice,
	recipient: WorkspaceDeletionNotice["recipients"][number],
	origin: string,
) {
	const church = notice.plant.name,
		owner = notice.requester.name;
	if (notice.kind === "cancelled")
		return {
			subject: `${church} is no longer being deleted`,
			text: `${owner} cancelled the deletion of the ${church} workspace on Everyfield. The church is back.\n\nSign in to Everyfield again to use it.`,
		};
	const until = deadline(notice.cancelUntil, recipient.timeZone ?? notice.plant.timeZone);
	const keep =
		recipient.accountId === notice.requester.accountId
			? `To keep the workspace, go to ${new URL("/workspace-deletion", origin).href}, sign in with your email and password, and choose "Keep the workspace".`
			: `To keep the workspace, contact ${owner}, the church's Owner.`;
	return {
		subject: `${church} is scheduled for deletion`,
		text: `${owner} asked to delete the ${church} workspace on Everyfield.\n\nChurch access is paused for everyone until ${until}. Only ${owner}, the Owner who asked, can cancel the deletion before then.\n\n${keep}`,
	};
}
