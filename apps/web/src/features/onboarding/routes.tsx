import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { onboardingEntry } from "./mount";
import { namesFor, viewerOf } from "../organizations/mount";
import { getViewer, organizationSeatOf } from "@/server/request-context";
import { signIn } from "@/server/sign-in";
import { DISCOVERY_HOME, ORGANIZATION_HOME } from "@everyfield/contracts/identity";
import { FOUNDATION_ARTICLES } from "./foundations";
import { addressStep, initialState, parseStep } from "./model";
import { parseEntry } from "./port";
import { RealOnboarding } from "./RealOnboarding";

export const onboardingMetadata: Metadata = { title: "Set up your church", robots: { index: false, follow: false } };

type Search = Promise<Record<string, string | string[] | undefined>>;
export async function OnboardingPage({ searchParams }: { searchParams: Search }) {
	const viewer = await getViewer();
	if (organizationSeatOf(viewer.authority)) redirect(ORGANIZATION_HOME);
	const context = viewer.authority?.actor.context;
	const load = parseEntry(await onboardingEntry(viewer));
	if (load.kind === "signed_out") signIn("/onboarding");
	const search = await searchParams;
	const raw = search.step;
	const requested = parseStep(typeof raw === "string" ? raw : null);
	if (load.entry.kind === "discovery") {
		if (search.start !== "church" || context?.kind !== "account") redirect(DISCOVERY_HOME);
		const who = await viewerOf();
		const names =
			who.kind === "viewer"
				? await namesFor(
						who.mount.db,
						who.viewer,
						load.entry.profile.relationships.map((r) => r.organization.id),
					)
				: {};
		return <RealOnboarding entry={load.entry} step={null} articles={FOUNDATION_ARTICLES} linkNames={names} />;
	}
	const step = addressStep(initialState(load.entry, requested));
	if (step !== (raw ?? null)) redirect(step ? `/onboarding?step=${step}` : "/onboarding");
	return <RealOnboarding entry={load.entry} step={requested} articles={FOUNDATION_ARTICLES} />;
}
