"use client";

import { Button } from "@everyfield/ui/controls";
import { useState, type ReactNode } from "react";
import { stepDone, type Entry, type StepKey } from "./model";
import { OnboardingFrame, StepHeading, StepPills } from "./parts";
import type { OnboardingPort } from "./port";
import { ChooseStart, CreateChurch, DiscoveryHome, StartDiscovery } from "./steps/Start";
import { ChurchSummary, FinishStep, JourneyStep, LaunchStep, TeamStep } from "./steps/Setup";
import { OnboardingProvider, useOnboarding } from "./store";

export type Article = { id: string; title: string };

/**
 * The onboarding page (#/onboarding). `port` is the real API on /onboarding and the fixture API on the design
 * preview. `account` slots in the account controls (sign out) from the identity feature.
 */
export function OnboardingFlow({
	port,
	entry,
	step,
	articles,
	signIn,
	account,
}: {
	port: OnboardingPort;
	entry: Entry;
	step: StepKey | null;
	articles: Article[];
	signIn: () => void;
	account?: ReactNode;
}) {
	return (
		<OnboardingProvider port={port} entry={entry} step={step} signIn={signIn}>
			<Screens articles={articles} account={account} />
		</OnboardingProvider>
	);
}

function Screens({ articles, account }: { articles: Article[]; account?: ReactNode }) {
	const { state, actions } = useOnboarding();
	const [paused, setPaused] = useState(false);
	const { entry } = state;

	if (entry.kind === "confirm_email" || entry.kind === "elsewhere")
		return (
			<OnboardingFrame>
				<Elsewhere entry={entry} onReload={() => void actions.refresh()} account={account} />
			</OnboardingFrame>
		);

	if (entry.kind === "start") {
		const body =
			entry.offer === "planter" ? (
				<CreateChurch state={state} actions={actions} />
			) : entry.offer === "discovery" ? (
				<StartDiscovery state={state} actions={actions} />
			) : (
				<ChooseStart state={state} actions={actions} />
			);
		const pills = entry.offer === "discovery" ? undefined : <StepPills current="church" done={() => false} />;
		return <OnboardingFrame steps={pills}>{body}</OnboardingFrame>;
	}

	if (entry.kind === "discovery")
		return (
			<OnboardingFrame>
				<DiscoveryHome state={state} actions={actions} articles={articles} />
				{account ? <div className="mx-auto mt-10 flex max-w-[820px] justify-end">{account}</div> : null}
			</OnboardingFrame>
		);

	const { resume, plantName } = entry;
	const props = { state, actions, resume, plantName };
	const later = (
		<Button variant="ghost" size="sm" onClick={() => setPaused(true)}>
			Save and finish later
		</Button>
	);
	if (paused)
		return (
			<OnboardingFrame>
				<section data-onboarding-step="paused">
					<StepHeading title="Your setup is saved">
						Every step you saved is kept. Come back to this page any time to pick up where you left off.
					</StepHeading>
					<div className="mx-auto mt-[30px] flex max-w-[620px] flex-col items-center gap-6">
						<Button variant="primary" onClick={() => setPaused(false)}>
							Back to setup
						</Button>
						{account}
					</div>
				</section>
			</OnboardingFrame>
		);
	const view = state.view;
	return (
		<OnboardingFrame
			steps={<StepPills current={view} done={(k) => stepDone(k, resume)} onGo={actions.go} />}
			aside={view === "finish" && resume.completion.status === "completed" ? undefined : later}
		>
			{view === "church" ? <ChurchSummary {...props} /> : null}
			{view === "journey" ? <JourneyStep {...props} /> : null}
			{view === "launch" ? <LaunchStep {...props} /> : null}
			{view === "team" ? <TeamStep {...props} /> : null}
			{view === "finish" ? <FinishStep {...props} articleCount={articles.length} after={account} /> : null}
		</OnboardingFrame>
	);
}

function Elsewhere({
	entry,
	onReload,
	account,
}: {
	entry: Extract<Entry, { kind: "confirm_email" | "elsewhere" }>;
	onReload: () => void;
	account?: ReactNode;
}) {
	const copy =
		entry.kind === "confirm_email"
			? {
					title: "Confirm your email first",
					body: "We sent a confirmation link to your inbox. Open it, then come back to this page.",
				}
			: entry.reason === "member"
				? {
						title: "Setup belongs to the Owner",
						body: "Only the church’s Owner sets it up. You can use the church as it is.",
					}
				: entry.reason === "organization"
					? {
							title: "This account is for an organization",
							body: "Church setup is for church planters. Your organization is set up separately.",
						}
					: { title: "Setup isn’t available right now", body: "We couldn’t load your setup. Try again in a moment." };
	return (
		<section data-onboarding-step="elsewhere">
			<StepHeading title={copy.title}>{copy.body}</StepHeading>
			<div className="mx-auto mt-[30px] flex max-w-[620px] flex-col items-center gap-6">
				<Button variant="primary" onClick={onReload}>
					{entry.kind === "confirm_email" ? "I’ve confirmed it" : "Try again"}
				</Button>
				{account}
			</div>
		</section>
	);
}
