"use client";

import { useMemo } from "react";
import { loadPage } from "../identity/api";
import { SessionActions } from "../identity/SessionActions";
import { loadOnboardingEntry, runOnboardingCommand } from "./actions";
import type { Entry, StepKey } from "./model";
import { OnboardingFlow, type Article } from "./OnboardingFlow";
import { createPort } from "./port";

const SIGN_IN = "/signin?returnTo=%2Fonboarding";

/** /onboarding on the real API: the server actions behind the contract-parsing port. */
export function RealOnboarding({ entry, step, articles }: { entry: Entry; step: StepKey | null; articles: Article[] }) {
	const port = useMemo(() => createPort({ entry: loadOnboardingEntry, command: runOnboardingCommand }), []);
	return (
		<OnboardingFlow
			port={port}
			entry={entry}
			step={step}
			articles={articles}
			signIn={() => loadPage(SIGN_IN)}
			account={<SessionActions />}
		/>
	);
}
