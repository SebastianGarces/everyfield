"use client";

import { DISCOVERY_HOME } from "@everyfield/contracts/identity";
import { Checkbox, InlineAlert } from "@everyfield/ui/controls";
import { useState } from "react";
import { basicsInput, type Relationship, type State } from "../model";
import { ChoiceCard, Notice, StepFooter, StepHeading } from "../parts";
import type { Actions } from "../store";
import { loadPage } from "../../identity/api";
import { BasicsForm } from "./Basics";

type Props = { state: State; actions: Actions };

export function CreateChurch({ state, actions, onBack }: Props & { onBack?: () => void }) {
	return (
		<section data-onboarding-step="church">
			<StepHeading title="Start your church">
				Name it and say where it is. It starts in Phase 1, Core group development.
			</StepHeading>
			<Notice notice={state.notice} op="createPlant" />
			<BasicsForm
				draft={state.drafts.basics}
				onEdit={(basics) => actions.edit({ basics })}
				busy={state.pending === "createPlant"}
				onBack={onBack}
				submitLabel="Create church"
				onSubmit={() => void actions.run("createPlant", basicsInput(state.drafts.basics))}
			>
				<p className="text-sm text-text-2 text-pretty">{SEAT_LINE}</p>
			</BasicsForm>
		</section>
	);
}

export function StartDiscovery({ state, actions, onBack }: Props & { onBack?: () => void }) {
	return (
		<section data-onboarding-step="church">
			<StepHeading title="Explore before you plant">
				Discovery is free for as long as you need. Read the whole Wiki, write private documents and ask Evry. No church
				is created until you start one.
			</StepHeading>
			<Notice notice={state.notice} op="createDiscovery" />
			<StepFooter
				onBack={onBack}
				busy={state.pending === "createDiscovery"}
				continueLabel="Open Discovery"
				onContinue={() =>
					void actions.run("createDiscovery", {}).then((result) => result === "ok" && loadPage(DISCOVERY_HOME))
				}
			/>
		</section>
	);
}

export function ChooseStart({ state, actions }: Props) {
	const [choice, setChoice] = useState<"plant" | "discovery" | null>(null);
	const [chosen, setChosen] = useState<"plant" | "discovery" | null>(null);
	const [problem, setProblem] = useState(false);
	if (chosen === "plant") return <CreateChurch state={state} actions={actions} onBack={() => setChosen(null)} />;
	if (chosen === "discovery") return <StartDiscovery state={state} actions={actions} onBack={() => setChosen(null)} />;
	return (
		<section data-onboarding-step="church">
			<StepHeading title="How do you want to start?">You can start a church now, or explore first.</StepHeading>
			<fieldset className="mx-auto mt-[34px] grid max-w-[820px] gap-3 sm:grid-cols-2">
				<legend className="sr-only">How to start</legend>
				<ChoiceCard
					name="start"
					value="plant"
					checked={choice === "plant"}
					onChange={() => (setChoice("plant"), setProblem(false))}
					title="Start a church"
					detail="Create it now. It starts in Phase 1."
				/>
				<ChoiceCard
					name="start"
					value="discovery"
					checked={choice === "discovery"}
					onChange={() => (setChoice("discovery"), setProblem(false))}
					title="Explore in Discovery"
					detail="Read the foundations first. No church yet."
				/>
			</fieldset>
			<InlineAlert className="mx-auto mt-4 max-w-[820px]">
				{problem ? "Choose how you want to start." : null}
			</InlineAlert>
			<StepFooter onContinue={() => (choice ? setChosen(choice) : setProblem(true))} />
		</section>
	);
}

const kindLabel = (r: Relationship) =>
	r.organization.organizationKind === "sending_network" ? "Sending network" : "Sending church";

export const SEAT_LINE =
	"Your sending church or network can cover your church's seat. If you plant on your own, you can pay for your seat yourself.";

export function ConvertDiscovery({ state, actions, names }: Props & { names: Record<string, string> }) {
	if (state.entry.kind !== "discovery") return <Opening />;
	const profile = state.entry.profile;
	const ending = new Set<string>(state.drafts.ending);
	const nameOf = (r: Relationship) => names[r.organization.id] ?? kindLabel(r);
	const toggle = (id: string, on: boolean) =>
		actions.edit({ ending: on ? [...state.drafts.ending, id] : state.drafts.ending.filter((k) => k !== id) });
	return (
		<section data-onboarding-step="church">
			<StepHeading title="Start your church">
				It starts in Phase 1, Core group development. Your documents and reading stay yours.
			</StepHeading>
			<Notice notice={state.notice} op="convertDiscovery" />
			<BasicsForm
				draft={state.drafts.basics}
				onEdit={(basics) => actions.edit({ basics })}
				busy={state.pending === "convertDiscovery"}
				onBack={() => loadPage(DISCOVERY_HOME)}
				submitLabel="Create church"
				onSubmit={() =>
					void actions.run("convertDiscovery", {
						...basicsInput(state.drafts.basics),
						discoveryId: profile.discoveryId,
						relationships: profile.relationships
							.filter((r) => !ending.has(r.relationshipId))
							.map((r) => ({
								relationshipId: r.relationshipId,
								organization: r.organization,
								expectedRelationshipRevision: r.revision,
								expectedConsentRevision: r.consentRevision,
								choices: r.choices,
							})),
						ended: profile.relationships
							.filter((r) => ending.has(r.relationshipId))
							.map((r) => ({
								relationshipId: r.relationshipId,
								organization: r.organization,
								expectedRelationshipRevision: r.revision,
							})),
					})
				}
			>
				{profile.relationships.length ? (
					<fieldset className="flex flex-col gap-3">
						<legend className="mb-1 text-sm font-medium text-ink-2">Your sending church or network</legend>
						{profile.relationships.map((r) => {
							const ends = ending.has(r.relationshipId);
							return (
								<div key={r.relationshipId} className="rounded-md border border-line px-3 py-2.5">
									<p className="text-sm font-medium text-ink">
										{nameOf(r)} <span className="font-normal text-text-3">· {kindLabel(r)}</span>
									</p>
									<p className="mt-0.5 text-xs text-text-2" aria-live="polite">
										{ends
											? `Your connection with ${nameOf(r)} ends when the church is created.`
											: `${nameOf(r)} stays connected to your church. It sees nothing new unless you choose to share.`}
									</p>
									<div className="mt-2">
										<Checkbox
											checked={ends}
											onCheckedChange={(on) => toggle(r.relationshipId, on === true)}
											label={`End my connection with ${nameOf(r)}`}
										/>
									</div>
								</div>
							);
						})}
					</fieldset>
				) : null}
				<p className="text-sm text-text-2 text-pretty">{SEAT_LINE}</p>
			</BasicsForm>
		</section>
	);
}

function Opening() {
	return (
		<section data-onboarding-step="church">
			<StepHeading title="Opening Discovery">Your free Discovery space is ready.</StepHeading>
		</section>
	);
}
