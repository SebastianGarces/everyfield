"use client";

import { cancelAccountDeletion, getAccountDeletionStatus, openAccountDeletion } from "../actions";
import type { DeletionPort, DeletionStatus, Reply } from "../port";
import { useBrowserZone } from "@everyfield/ui/foundations";
import { DeletionStatusScreen } from "./DeletionStatusScreen";

const PORT: DeletionPort = {
	open: openAccountDeletion,
	getStatus: getAccountDeletionStatus,
	cancel: cancelAccountDeletion,
};

export function AccountDeletionScreen({
	initial,
	requestedUntil,
}: {
	initial: Promise<Reply<DeletionStatus>>;
	requestedUntil: string | null;
}) {
	return (
		<DeletionStatusScreen
			subject={{ kind: "account" }}
			port={PORT}
			initial={initial}
			requestedUntil={requestedUntil}
			now={Date.now}
			zone={useBrowserZone() ?? "UTC"}
			signInHref="/signin"
		/>
	);
}
