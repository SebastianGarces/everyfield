import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PATH_HEADER } from "@/proxy";
import { readEmailChangeProof } from "@/server/email-change-proof";
import { getViewer } from "@/server/request-context";
import { requireActor } from "@/server/sign-in";
import { instant } from "@everyfield/contracts/common";
import { confirmEmailChange } from "./actions";
import { readBrand } from "./brand/server";
import { ConfirmEmailScreen } from "./restricted/ConfirmEmailScreen";
import { AccountDeletionScreen } from "./restricted/AccountDeletionScreen";
import { WorkspaceDeletionScreen } from "./restricted/WorkspaceDeletionScreen";
import { readSection, restrictedStatus } from "./server";
import { dialogSection, offeredSections, sectionAt, sectionRequest } from "./model";
import type { SectionSeed, SettingsViewer } from "./port";

export const settingsMetadata: Metadata = { title: "Settings", robots: { index: false, follow: false } };

export async function SettingsSectionPage({ params }: { params: Promise<{ section: string }> }) {
	const section = dialogSection((await params).section);
	if (!section) notFound();
	await requireActor(`/settings/${section}`);
	return <h1 className="sr-only">Settings</h1>;
}

export async function SettingsIndexPage() {
	await requireActor("/settings");
	return <h1 className="sr-only">Settings</h1>;
}

export async function sectionSeed(viewer: SettingsViewer | null): Promise<SectionSeed | null> {
	const section = sectionAt((await headers()).get(PATH_HEADER) ?? "", viewer);
	if (viewer && section === "brand" && offeredSections(viewer, []).includes("brand"))
		return { brand: getViewer().then(readBrand) };
	const request = viewer && section ? sectionRequest(viewer, section) : null;
	if (!request) return null;
	return { request, value: getViewer().then((session) => readSection(session, request)) };
}

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

export const workspaceDeletionMetadata: Metadata = { ...accountDeletionMetadata, title: "Church workspace deletion" };

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
