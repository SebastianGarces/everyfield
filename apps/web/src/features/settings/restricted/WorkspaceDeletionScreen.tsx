"use client";

import { cancelWorkspaceDeletion, getWorkspaceDeletionStatus, openWorkspaceDeletion } from "../actions";
import type { DeletionPort, DeletionStatus, Reply } from "../port";
import { DeletionStatusScreen, useBrowserZone } from "./DeletionStatusScreen";

const PORT: DeletionPort = {
	open: openWorkspaceDeletion,
	getStatus: getWorkspaceDeletionStatus,
	cancel: cancelWorkspaceDeletion,
};

/** The product's restricted deletion page for a church workspace (/workspace-deletion), for the Owner who asked. */
export function WorkspaceDeletionScreen({
	initial,
	requestedUntil,
}: {
	initial: Promise<Reply<DeletionStatus>>;
	requestedUntil: string | null;
}) {
	return (
		<DeletionStatusScreen
			subject={{ kind: "workspace" }}
			port={PORT}
			initial={initial}
			requestedUntil={requestedUntil}
			now={Date.now}
			zone={useBrowserZone()}
			signInHref="/signin"
		/>
	);
}
