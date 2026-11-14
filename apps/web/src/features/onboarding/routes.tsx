import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requestDatabase } from "@/server/database";
import { onboardingEntry } from "@/server/onboarding";
import { getViewer } from "@/server/request-context";
import { readResidencyLink } from "@everyfield/domain/organizations";
import { ORGANIZATION_HOME } from "@everyfield/contracts/identity";
import { FOUNDATION_ARTICLES } from "./foundations";
import { parseStep } from "./model";
import { parseEntry } from "./port";
import { RealOnboarding } from "./RealOnboarding";

// The /onboarding route, a bare product page (screens.md): no top bar or rail. apps/web/src/app/(product)/onboarding/
// only re-exports these (WP-009/ui R1).

export const onboardingMetadata: Metadata = { title: "Set up your church", robots: { index: false, follow: false } };

type Search = Promise<Record<string, string | string[] | undefined>>;
export async function OnboardingPage({ searchParams }: { searchParams: Search }) {
	// A sending church or network seat has its own home; church setup is for planters (WP-047a). An organization
	// registration without a seat yet still sees the onboarding screen that says so.
	const viewer = await getViewer();
	const context = viewer?.authority?.actor.context;
	if (context?.kind === "seat" && context.owner.kind === "organization") redirect(ORGANIZATION_HOME);
	const load = parseEntry(await onboardingEntry());
	if (load.kind === "signed_out") redirect("/signin?returnTo=%2Fonboarding");
	const raw = (await searchParams).step;
	// A seatless account linked to a residency reaches My residency from its Discovery home (WP-100).
	const db = requestDatabase();
	const residency =
		db && load.entry.kind === "discovery" && viewer?.status === "active" && viewer.authority
			? await readResidencyLink(db, viewer.authority)
			: null;
	return (
		<RealOnboarding
			residency={residency}
			entry={load.entry}
			step={parseStep(typeof raw === "string" ? raw : null)}
			articles={FOUNDATION_ARTICLES}
		/>
	);
}
