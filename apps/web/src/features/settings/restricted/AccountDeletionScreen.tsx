"use client";

import { cancelAccountDeletion, getAccountDeletionStatus, openAccountDeletion } from "../actions";
import type { DeletionPort, DeletionStatus, Reply } from "../port";
import { DeletionStatusScreen, useBrowserZone } from "./DeletionStatusScreen";

const PORT: DeletionPort = {
	open: openAccountDeletion,
	getStatus: getAccountDeletionStatus,
	cancel: cancelAccountDeletion,
};

/** The product's restricted deletion page for your own account (/account-deletion). */
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
			zone={useBrowserZone()}
			signInHref="/signin"
		/>
	);
}
