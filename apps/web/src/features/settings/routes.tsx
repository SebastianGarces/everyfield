import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { PATH_HEADER } from "@/proxy";
import { getViewer } from "@/server/request-context";
import { instant } from "@everyfield/contracts/common";
import { confirmEmailChange, getSection } from "./actions";
import { ConfirmEmailScreen } from "./restricted/ConfirmEmailScreen";
import { AccountDeletionScreen } from "./restricted/AccountDeletionScreen";
import { restrictedStatus } from "./server";
import { dialogSection, sectionAt, sectionRequest } from "./model";
import type { SectionSeed, SettingsViewer } from "./port";

export const settingsMetadata: Metadata = { title: "Settings", robots: { index: false, follow: false } };

/**
 * A fresh load of a settings section link (/settings/account). The frame's Settings dialog opens from the address;
 * this page is what lies underneath it. Signed-out visitors sign in and come back.
 */
export async function SettingsSectionPage({ params }: { params: Promise<{ section: string }> }) {
	const section = dialogSection((await params).section);
	if (!section) notFound();
	const v = await getViewer();
	if (!v || v.status === "unauthenticated") redirect(`/signin?returnTo=${encodeURIComponent(`/settings/${section}`)}`);
	return <h1 className="sr-only">Settings</h1>;
}

/**
 * /settings is the Settings dialog on the first section this viewer is offered, in one request: the frame's dialog
 * picks that section from the address (ProductSettings), so no role meets a missing page and there is no redirect.
 */
export async function SettingsIndexPage() {
	const v = await getViewer();
	if (!v || v.status === "unauthenticated") redirect(`/signin?returnTo=${encodeURIComponent("/settings")}`);
	return <h1 className="sr-only">Settings</h1>;
}

/**
 * A fresh load at a Settings address starts that section's read while the page renders, in the same request, and the
 * frame hands the pending result to the dialog. Without it the dialog asks again only after the page has hydrated.
 */
export async function sectionSeed(viewer: SettingsViewer | null): Promise<SectionSeed | null> {
	const section = sectionAt((await headers()).get(PATH_HEADER) ?? "", viewer);
	const request = viewer && section ? sectionRequest(viewer, section) : null;
	if (!request) return null;
	return { request, value: getSection(request) };
}

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);

export const accountDeletionMetadata: Metadata = {
	title: "Account deletion",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

/**
 * The restricted deletion page (REQ-IDN-032). It needs no normal session: the deletion request ended them all. The
 * status read starts with the page; without a restricted session it answers at once, with no database read, and the
 * page asks for the email and password. `until` is the deadline the request just returned, shown before that proof.
 */
export async function AccountDeletionPage({ searchParams }: { searchParams: Search }) {
	const until = instant.safeParse(one((await searchParams).until));
	return <AccountDeletionScreen initial={restrictedStatus()} requestedUntil={until.success ? until.data : null} />;
}

export const confirmEmailMetadata: Metadata = {
	title: "Confirm your new email",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

/**
 * The page the email-change link opens (REQ-IDN-007). Only the signed-in account that asked can confirm, so a
 * signed-out visitor signs in first and comes back to the same link.
 */
export async function ConfirmEmailPage({ searchParams }: { searchParams: Search }) {
	const token = one((await searchParams).token);
	const v = await getViewer();
	if (!v || v.status === "unauthenticated") {
		const back = token ? `/confirm-email?token=${encodeURIComponent(token)}` : "/confirm-email";
		redirect(`/signin?returnTo=${encodeURIComponent(back)}`);
	}
	return <ConfirmEmailScreen proof={token} confirm={confirmEmailChange} accountHref="/settings/account" />;
}
