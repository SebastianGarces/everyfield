"use client";

import { cancelWorkspaceDeletion, getWorkspaceDeletionStatus, openWorkspaceDeletion } from "../actions";
import type { DeletionPort, DeletionStatus, Reply } from "../port";
import { useBrowserZone } from "@everyfield/ui/foundations";
import { DeletionStatusScreen } from "./DeletionStatusScreen";

const PORT: DeletionPort = {
	open: openWorkspaceDeletion,
	getStatus: getWorkspaceDeletionStatus,
	cancel: cancelWorkspaceDeletion,
};

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
			zone={useBrowserZone() ?? "UTC"}
			signInHref="/signin"
		/>
	);
}
