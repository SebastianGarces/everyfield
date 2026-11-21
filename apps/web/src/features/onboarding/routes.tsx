import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { onboardingEntry } from "./mount";
import { ownResidencyLinks } from "../organizations/mount";
import { getViewer, organizationSeatOf } from "@/server/request-context";
import { signIn } from "@/server/sign-in";
import { ORGANIZATION_HOME } from "@everyfield/contracts/identity";
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
