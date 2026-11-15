"use client";

import { Select } from "@everyfield/ui/controls";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { loadPage } from "../../identity/api";
import { parseStep } from "../model";
import { OnboardingFlow, type Article } from "../OnboardingFlow";
import { createFixturePort, parsePersona, PERSONA_LABEL, PERSONAS } from "./fixtures";

/**
 * The onboarding design preview at /design/onboarding?as=<persona>. `delay` sets the reply time in milliseconds and
 * `fail=<op>:<code>` makes the first call of that command fail, and `fail=<op>:offline` drops the connection for it
 * instead. Replies come from the fixture API, parsed by the WP-009 contract. Browser tests read
 * window.__onboardingFixture to count requests.
 */
export function OnboardingPreview({ articles }: { articles: Article[] }) {
	const search = useSearchParams();
	const persona = parsePersona(search.get("as"));
	const [fixture] = useState(() => createFixturePort(persona, { faults: search.getAll("fail") }));
	const choose = (value: string) => {
		const url = new URL(window.location.href);
		url.search = `?as=${value}`;
		window.location.assign(url);
	};
	return (
		<>
			<OnboardingFlow
				key={persona}
				port={fixture.port}
				entry={fixture.entry}
				step={parseStep(search.get("step"))}
				articles={articles}
				signIn={() => loadPage("/signin")}
			/>
			<aside
				aria-label="Design preview"
				className="fixed right-4 bottom-4 z-10 w-[260px] rounded-md bg-surface-raised p-3 shadow-pop max-sm:static max-sm:mx-4 max-sm:mb-4 max-sm:w-auto"
			>
				<Select
					aria-label="Preview account"
					value={persona}
					onValueChange={choose}
					options={PERSONAS.map((p) => ({ value: p, label: PERSONA_LABEL[p] }))}
				/>
			</aside>
		</>
	);
}
