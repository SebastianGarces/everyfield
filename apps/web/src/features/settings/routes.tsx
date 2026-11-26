import type { Metadata } from "next";
import { readEmailChangeProof } from "@/server/email-change-proof";
import { requireActor } from "@/server/sign-in";
import { instant } from "@everyfield/contracts/common";
import { confirmEmailChange } from "./actions";
import { ConfirmEmailScreen } from "./restricted/ConfirmEmailScreen";
import { AccountDeletionScreen } from "./restricted/AccountDeletionScreen";
import { WorkspaceDeletionScreen } from "./restricted/WorkspaceDeletionScreen";
import { restrictedStatus } from "./server";

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);

export const accountDeletionMetadata: Metadata = {
	title: "Account deletion",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

export async function AccountDeletionPage({ searchParams }: { searchParams: Search }) {
	const until = instant.safeParse(one((await searchParams).until));
	return (
		<AccountDeletionScreen initial={restrictedStatus("account")} requestedUntil={until.success ? until.data : null} />
	);
}

export const workspaceDeletionMetadata: Metadata = {
	...accountDeletionMetadata,
	title: "Church plant account deletion",
};

export async function WorkspaceDeletionPage({ searchParams }: { searchParams: Search }) {
	const until = instant.safeParse(one((await searchParams).until));
	return (
		<WorkspaceDeletionScreen initial={restrictedStatus("plant")} requestedUntil={until.success ? until.data : null} />
	);
}

export const confirmEmailMetadata: Metadata = {
	title: "Confirm your new email",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

export async function ConfirmEmailPage() {
	await requireActor("/confirm-email");
	const linked = (await readEmailChangeProof()) !== null;
	return <ConfirmEmailScreen linked={linked} confirm={confirmEmailChange} accountHref="/settings/account" />;
}
