"use client";

import { useState } from "react";
import { loadPage } from "../identity/api";
import { SessionActions } from "../identity/SessionActions";
import { runOnboardingCommand } from "./actions";
import { loadOnboardingEntry } from "./fetch.ts";
import type { Entry, StepKey } from "./model";
import { OnboardingFlow, type Article } from "./OnboardingFlow";
import { createPort } from "./port";

const SIGN_IN = "/signin?returnTo=%2Fonboarding";

export function RealOnboarding({
	entry,
	step,
	articles,
	residency = null,
}: {
	entry: Entry;
	step: StepKey | null;
	articles: Article[];
	residency?: { organizationName: string } | null;
}) {
	const [port] = useState(() => createPort({ entry: loadOnboardingEntry, command: runOnboardingCommand }));
	return (
		<OnboardingFlow
			port={port}
			entry={entry}
			step={step}
			articles={articles}
			residency={residency}
			signIn={() => loadPage(SIGN_IN)}
			account={<SessionActions />}
		/>
	);
}
