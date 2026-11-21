import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { EMAIL_CHANGE_PROOF_COOKIE } from "@/proxy";
import { getViewer } from "@/server/request-context";
import { requireActor } from "@/server/sign-in";
import { instant } from "@everyfield/contracts/common";
import { confirmEmailChange } from "./actions";
import { readBrand } from "./brand/server";
import { ConfirmEmailScreen } from "./restricted/ConfirmEmailScreen";
import { AccountDeletionScreen } from "./restricted/AccountDeletionScreen";
import { WorkspaceDeletionScreen } from "./restricted/WorkspaceDeletionScreen";
import { readSection, restrictedStatus, settingsViewerOf } from "./server";
import { dialogSection, firstSection, offeredSections, sectionRequest, type DialogSection } from "./model";
import type { SectionSeed, SettingsViewer } from "./port";
import { ProductSettingsDialog } from "./ProductSettings";

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

function sectionSeed(viewer: SettingsViewer | null, section: DialogSection | null): SectionSeed | null {
	if (viewer && section === "brand" && offeredSections(viewer, []).includes("brand"))
		return { brand: getViewer().then(readBrand) };
	const request = viewer && section ? sectionRequest(viewer, section) : null;
	if (!request) return null;
	return { request, value: getViewer().then((session) => readSection(session, request)) };
}

export async function SettingsSectionDialog({ params }: { params: Promise<{ section: string }> }) {
	const viewer = settingsViewerOf(await getViewer());
	return <ProductSettingsDialog seed={sectionSeed(viewer, dialogSection((await params).section))} />;
}

export async function SettingsIndexDialog() {
	const viewer = settingsViewerOf(await getViewer());
	return <ProductSettingsDialog seed={sectionSeed(viewer, viewer ? firstSection(viewer) : null)} />;
}

export function SettingsDialogElsewhere() {
	return <ProductSettingsDialog seed={null} />;
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
	const proof = (await cookies()).get(EMAIL_CHANGE_PROOF_COOKIE)?.value ?? null;
	return <ConfirmEmailScreen proof={proof} confirm={confirmEmailChange} accountHref="/settings/account" />;
}
