import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { onboardingEntry } from "@/server/onboarding";
import { ownResidencyLinks } from "../organizations/mount";
import { getViewer } from "@/server/request-context";
import { ORGANIZATION_HOME } from "@everyfield/contracts/identity";
import { FOUNDATION_ARTICLES } from "./foundations";
import { addressStep, initialState, parseStep } from "./model";
import { parseEntry } from "./port";
import { RealOnboarding } from "./RealOnboarding";

export const onboardingMetadata: Metadata = { title: "Set up your church", robots: { index: false, follow: false } };

type Search = Promise<Record<string, string | string[] | undefined>>;
export async function OnboardingPage({ searchParams }: { searchParams: Search }) {
	const viewer = await getViewer();
	const context = viewer?.authority?.actor.context;
	if (context?.kind === "seat" && context.owner.kind === "organization") redirect(ORGANIZATION_HOME);
	const load = parseEntry(await onboardingEntry());
	if (load.kind === "signed_out") redirect("/signin?returnTo=%2Fonboarding");
	const raw = (await searchParams).step;
	const requested = parseStep(typeof raw === "string" ? raw : null);
	const step = addressStep(initialState(load.entry, requested));
	if (step !== (raw ?? null)) redirect(step ? `/onboarding?step=${step}` : "/onboarding");
	const live =
		load.entry.kind === "discovery" && context?.kind === "account"
			? (await ownResidencyLinks()).find((l) => l.sharing.status === "active")
			: undefined;
	const residency = live ? { organizationName: live.organizationName } : null;
	return <RealOnboarding residency={residency} entry={load.entry} step={requested} articles={FOUNDATION_ARTICLES} />;
}
