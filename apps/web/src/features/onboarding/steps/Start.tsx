"use client";

import { Button, Checkbox } from "@everyfield/ui/controls";
import { useState } from "react";
import { basicsInput, type Relationship, type State } from "../model";
import { ChoiceCard, Notice, StepFooter, StepHeading } from "../parts";
import type { Actions } from "../store";
import { BasicsForm } from "./Basics";

type Props = { state: State; actions: Actions };

/** Create the church: the one creation this account makes (D43). */
export function CreateChurch({ state, actions, onBack }: Props & { onBack?: () => void }) {
	return (
		<section data-onboarding-step="church">
			<StepHeading title="Start your church">
				Name it and say where it is. It starts in Phase 1, Core group development.
			</StepHeading>
			<Notice code={state.notice?.op === "createPlant" ? state.notice.code : null} />
			<BasicsForm
				draft={state.drafts.basics}
				onEdit={(basics) => actions.edit({ basics })}
				busy={state.pending === "createPlant"}
				onBack={onBack}
				submitLabel="Create church"
				onSubmit={() => void actions.run("createPlant", basicsInput(state.drafts.basics))}
			/>
		</section>
	);
}

/** Start Discovery: a private space with no church and no seat (REQ-IDN-016). */
export function StartDiscovery({ state, actions, onBack }: Props & { onBack?: () => void }) {
	return (
		<section data-onboarding-step="church">
			<StepHeading title="Explore before you plant">
				Discovery is your own space to read the foundations and test the call. No church is created until you start one.
			</StepHeading>
			<Notice code={state.notice?.op === "createDiscovery" ? state.notice.code : null} />
			<StepFooter
				onBack={onBack}
				busy={state.pending === "createDiscovery"}
				continueLabel="Open Discovery"
				onContinue={() => void actions.run("createDiscovery", {})}
			/>
		</section>
	);
}

/** An active account without a seat chooses explicitly (D42). Nothing is inferred from the missing seat. */
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
			{problem ? (
				<p role="alert" className="mx-auto mt-4 max-w-[820px] text-sm font-medium text-magenta-600">
					Choose how you want to start.
				</p>
			) : null}
			<StepFooter onContinue={() => (choice ? setChosen(choice) : setProblem(true))} />
		</section>
	);
}

const CATEGORY: Record<string, string> = {
	people: "People",
	meetings: "Meetings",
	tasks: "Tasks",
	ministry_teams: "Ministry teams",
	wiki: "Wiki",
	activity: "Activity",
	shared_findings: "Shared findings",
};
const shared = (r: Relationship) =>
	Object.entries(r.choices)
		.filter(([, on]) => on)
		.map(([k]) => CATEGORY[k] ?? k);
const kindLabel = (r: Relationship) =>
	r.organization.organizationKind === "sending_network" ? "Network relationship" : "Sending church relationship";

/** Discovery: own reading and relationships, and Start your church as conversion (REQ-IDN-016, R7). */
export function DiscoveryHome({ state, actions, articles }: Props & { articles: { id: string; title: string }[] }) {
	const [converting, setConverting] = useState(false);
	if (state.entry.kind !== "discovery") return null;
	const profile = state.entry.profile;
	const read = new Set<string>(profile.reading.articles.map((a) => a.articleId));
	const keep = new Set<string>(state.drafts.keep);
	if (converting) {
		const toggle = (id: string, on: boolean) =>
			actions.edit({ keep: on ? [...state.drafts.keep, id] : state.drafts.keep.filter((k) => k !== id) });
		return (
			<section data-onboarding-step="church">
				<StepHeading title="Start your church">
					Your Discovery space becomes a church in Phase 1. Your reading stays with you.
				</StepHeading>
				<Notice code={state.notice?.op === "convertDiscovery" ? state.notice.code : null} />
				<BasicsForm
					draft={state.drafts.basics}
					onEdit={(basics) => actions.edit({ basics })}
					busy={state.pending === "convertDiscovery"}
					onBack={() => setConverting(false)}
					submitLabel="Create church"
					onSubmit={() =>
						void actions.run("convertDiscovery", {
							...basicsInput(state.drafts.basics),
							discoveryId: profile.discoveryId,
							relationships: profile.relationships
								.filter((r) => keep.has(r.relationshipId))
								.map((r) => ({
									relationshipId: r.relationshipId,
									organization: r.organization,
									expectedRelationshipRevision: r.revision,
									expectedConsentRevision: r.consentRevision,
									choices: r.choices,
								})),
						})
					}
				>
					{profile.relationships.length ? (
						<fieldset>
							<legend className="mb-1 text-sm font-medium text-ink-2">Relationships to bring</legend>
							<p className="text-xs text-text-3">
								Only the ones you tick move to the church, with what they share today. The rest end.
							</p>
							{profile.relationships.map((r) => (
								<Checkbox
									key={r.relationshipId}
									checked={keep.has(r.relationshipId)}
									onCheckedChange={(on) => toggle(r.relationshipId, on === true)}
									label={kindLabel(r)}
									description={shared(r).length ? `Shares ${shared(r).join(", ")}` : "Shares nothing"}
								/>
							))}
						</fieldset>
					) : null}
				</BasicsForm>
			</section>
		);
	}
	return (
		<section data-onboarding-step="church">
			<StepHeading title="Discovery">
				Your private space to explore church planting. Nothing here is shared with a church until you choose.
			</StepHeading>
			<div className="mx-auto mt-[34px] grid max-w-[820px] gap-4 md:grid-cols-2">
				<div className="rounded-card border border-line bg-surface-raised p-6 shadow-card">
					<h2 className="font-sans text-md font-semibold tracking-normal text-ink">Foundations</h2>
					<p className="mt-1 text-sm text-text-2">
						{read.size} of {articles.length} read. Reading never blocks starting a church.
					</p>
					<ul className="mt-3 flex flex-col gap-2 text-sm">
						{articles.map((a) => (
							<li key={a.id} className="flex items-center gap-2 text-ink">
								<span
									aria-hidden="true"
									className={read.has(a.id) ? "size-2 rounded-full bg-green-500" : "size-2 rounded-full bg-surface-3"}
								/>
								{a.title}
								<span className="sr-only">{read.has(a.id) ? "(read)" : "(not read)"}</span>
							</li>
						))}
					</ul>
				</div>
				<div className="rounded-card border border-line bg-surface-raised p-6 shadow-card">
					<h2 className="font-sans text-md font-semibold tracking-normal text-ink">Relationships</h2>
					{profile.relationships.length ? (
						<ul className="mt-2 flex flex-col gap-3 text-sm">
							{profile.relationships.map((r) => (
								<li key={r.relationshipId}>
									<span className="text-ink">{kindLabel(r)}</span>
									<span className="block text-text-3">
										{shared(r).length ? `Shares ${shared(r).join(", ")}` : "Shares nothing"}
									</span>
								</li>
							))}
						</ul>
					) : (
						<p className="mt-1 text-sm text-text-2">No sending church or network yet.</p>
					)}
				</div>
			</div>
			<div className="mx-auto mt-[30px] flex max-w-[820px] justify-end">
				<Button variant="primary" onClick={() => setConverting(true)}>
					Start your church
				</Button>
			</div>
		</section>
	);
}
