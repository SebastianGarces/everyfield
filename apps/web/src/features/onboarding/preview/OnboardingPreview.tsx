"use client";

import { Select } from "@everyfield/ui/controls";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";
import { loadPage } from "../../identity/api";
import type { ErrorCode, Op } from "../model";
import { parseStep } from "../model";
import { OnboardingFlow, type Article } from "../OnboardingFlow";
import { createFixturePort, parsePersona, PERSONA_LABEL, PERSONAS } from "./fixtures";

/**
 * The onboarding design preview at /design/onboarding?as=<persona>. `delay` sets the reply time in milliseconds and
 * `fail=<op>:<code>` makes the first call of that command fail. Replies come from the fixture API, parsed by the
 * WP-009 contract. Browser tests read window.__onboardingFixture to count requests.
 */
export function OnboardingPreview({ articles }: { articles: Article[] }) {
	const search = useSearchParams();
	const persona = parsePersona(search.get("as"));
	const delay = Number(search.get("delay") ?? 450);
	const fixture = useMemo(() => createFixturePort(persona, { delay }), [persona, delay]);
	useEffect(() => {
		for (const spec of search.getAll("fail")) {
			const [op, code] = spec.split(":");
			if (op && code) fixture.controls.failNext(op as Op, code as ErrorCode);
		}
		(window as unknown as { __onboardingFixture?: unknown }).__onboardingFixture = fixture.controls;
		// Faults from the URL apply once per fixture.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fixture]);
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
