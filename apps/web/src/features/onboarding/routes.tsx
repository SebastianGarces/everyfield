import { parseTheme, ProductRoot, THEME_COOKIE } from "@everyfield/ui/foundations";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { onboardingEntry } from "@/server/onboarding";
import { FOUNDATION_ARTICLES } from "./foundations";
import { parseStep } from "./model";
import { parseEntry } from "./port";
import { RealOnboarding } from "./RealOnboarding";

// The /onboarding route. apps/web/src/app/onboarding/ only re-exports these (WP-009/ui R1).

/** A bare page (screens.md): no top bar or rail, inside the product root so the product theme applies. */
export async function OnboardingLayout({ children }: { children: ReactNode }) {
	const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
	return <ProductRoot initialTheme={theme}>{children}</ProductRoot>;
}

export const onboardingMetadata: Metadata = { title: "Set up your church", robots: { index: false, follow: false } };

type Search = Promise<Record<string, string | string[] | undefined>>;
export async function OnboardingPage({ searchParams }: { searchParams: Search }) {
	const load = parseEntry(await onboardingEntry(await headers()));
	if (load.kind === "signed_out") redirect("/signin?returnTo=%2Fonboarding");
	const raw = (await searchParams).step;
	return (
		<RealOnboarding
			entry={load.entry}
			step={parseStep(typeof raw === "string" ? raw : null)}
			articles={FOUNDATION_ARTICLES}
		/>
	);
}
