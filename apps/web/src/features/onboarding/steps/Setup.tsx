"use client";

import { Button, Field, Input } from "@everyfield/ui/controls";
import { cn } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
	DEFAULT_LEAD,
	PHASES,
	finished,
	journeyInput,
	journeyLocked,
	launchInput,
	leadInput,
	leadLocked,
	leadProblems,
	missingFacts,
	nextStep,
	previousStep,
	shownJourney,
	shownLaunch,
	shownLead,
	type JourneyDraft,
	type LaunchDraft,
	type LeadDraft,
	type Resume,
	type State,
} from "../model";
import { ChoiceCard, Notice, SavedCard, StepFooter, StepHeading } from "../parts";
import type { Actions } from "../store";

type Props = { state: State; actions: Actions; resume: Resume; plantName: string | null };
/** The product home: the app shell's homeHref (PeopleFrame). There is no separate /dashboard route. */
const DASHBOARD_HREF = "/people";
const churchName = (name: string | null) => name ?? "your church";
const phaseName = (n: number) => PHASES[n]?.name ?? `Phase ${n}`;
const longDate = (iso: string) =>
	new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});

/** After creation, Your church is a summary. Basics are never reentered here (REQ-IDN-013, REQ-IDN-015). */
export function ChurchSummary({ actions, plantName }: Props) {
	return (
		<section data-onboarding-step="church">
			<StepHeading title={`${plantName ?? "Your church"} is set up`} mood="happy">
				You are its Owner. To rename it or change where it is, use Settings later.
			</StepHeading>
			<SavedCard title="Church created">It starts in Phase 1, Core group development, from today.</SavedCard>
			<StepFooter onContinue={() => actions.go("journey")} />
		</section>
	);
}

/** Where you are: an optional attestation of an existing phase, or an answer that keeps the actual phase (R4). */
export function JourneyStep({ state, actions, resume, plantName }: Props) {
	const [problem, setProblem] = useState<string | null>(null);
	const name = churchName(plantName);
	if (journeyLocked(resume) && resume.journey.status === "saved" && resume.journey.value.answer === "existing") {
		const phase = resume.journey.value.phase;
		return (
			<section data-onboarding-step="journey">
				<StepHeading title={`Where is ${name} today?`} />
				<SavedCard title={`You declared Phase ${phase}, ${phaseName(phase)}`}>
					We recorded it as where {name} already was when it joined Everyfield. To change it later, record a phase
					change with a reason.
				</SavedCard>
				<StepFooter onBack={() => actions.go("church")} onContinue={() => actions.go("launch")} />
			</section>
		);
	}
	const shown = shownJourney(state);
	const value = shown ? (shown.answer === "existing" ? `phase-${shown.phase}` : shown.answer) : "";
	const choose = (v: string) => {
		setProblem(null);
		const draft: JourneyDraft = v.startsWith("phase-")
			? { answer: "existing", phase: Number(v.slice(6)) }
			: { answer: v as "unsure" | "discerning" };
		actions.edit({ journey: draft });
	};
	const current = resume.currentPhase;
	return (
		<section data-onboarding-step="journey">
			<StepHeading title={`Where is ${name} today?`}>
				{name[0]!.toUpperCase() + name.slice(1)} is in Phase {current}, {phaseName(current)}. If you were already
				further along when you joined, pick that phase. We will not invent history for the phases before it.
			</StepHeading>
			<fieldset className="mx-auto mt-[34px] max-w-[820px]">
				<legend className="sr-only">Your phase today</legend>
				<div className="grid gap-3 sm:grid-cols-2">
					{PHASES.map((p) => (
						<ChoiceCard
							key={p.phase}
							name="journey"
							value={`phase-${p.phase}`}
							checked={value === `phase-${p.phase}`}
							onChange={choose}
							badge={p.phase}
							title={p.name}
							detail={p.detail}
							className={cn(p.phase === 6 && "sm:col-span-2")}
						/>
					))}
				</div>
				<p className="mt-6 mb-3 text-center text-sm text-text-3">Not ready to say? These keep Phase {current}.</p>
				<div className="grid gap-3 sm:grid-cols-2">
					<ChoiceCard
						name="journey"
						value="unsure"
						checked={value === "unsure"}
						onChange={choose}
						title="I’m not sure yet"
						detail="Decide later. Nothing is declared."
					/>
					<ChoiceCard
						name="journey"
						value="discerning"
						checked={value === "discerning"}
						onChange={choose}
						title="We’re still discerning"
						detail="Still testing the call. Nothing is declared."
					/>
				</div>
			</fieldset>
			{problem ? (
				<p role="alert" className="mx-auto mt-4 max-w-[820px] text-sm font-medium text-magenta-600">
					{problem}
				</p>
			) : null}
			<Notice code={state.notice?.op === "declareJourney" ? state.notice.code : null} />
			<StepFooter
				onBack={() => actions.go("church")}
				onSkip={() => {
					actions.edit({ journey: { answer: "skip" } });
					actions.go("launch");
				}}
				onContinue={() => {
					if (!shown) return setProblem("Choose a phase, or one of the answers below the phases.");
					if (!state.drafts.journey) actions.edit({ journey: shown });
					actions.go("launch");
				}}
			/>
		</section>
	);
}

/** Launch date. It saves together with the phase answer as one request (R4); No date never clears a saved date. */
export function LaunchStep({ state, actions, resume, plantName }: Props) {
	const [problem, setProblem] = useState<string | null>(null);
	const name = churchName(plantName);
	const back = () => actions.go("journey");
	if (journeyLocked(resume)) {
		const launch = resume.launch.status === "saved" ? resume.launch.value : null;
		return (
			<section data-onboarding-step="launch">
				<StepHeading title="When do you plan to launch?" />
				<SavedCard
					title={
						resume.scheduledLaunchDate ? `Launch date: ${longDate(resume.scheduledLaunchDate)}` : "No launch date yet"
					}
				>
					{launch?.answer === "skip" ? "You skipped this step. " : ""}Add or change the date in the launch plan later.
				</SavedCard>
				<StepFooter onBack={back} onContinue={() => actions.go(nextStep("launch"))} />
			</section>
		);
	}
	const shown = shownLaunch(state);
	const journey = shownJourney(state);
	const busy = state.pending === "declareJourney";
	const save = (launch: LaunchDraft) => {
		if (!journey) return actions.go("journey");
		void actions.run("declareJourney", { journey: journeyInput(journey), launch: launchInput(launch) });
	};
	const saved = resume.scheduledLaunchDate;
	return (
		<section data-onboarding-step="launch">
			<StepHeading title="When do you plan to launch?">
				A target date lets {name} plan back from Launch Sunday. You can change it later in the launch plan.
			</StepHeading>
			<fieldset className="mx-auto mt-[34px] grid max-w-[820px] gap-3">
				<legend className="sr-only">Launch date</legend>
				<ChoiceCard
					name="launch"
					value="planned"
					checked={shown?.answer === "planned"}
					onChange={() => {
						setProblem(null);
						actions.edit({
							launch: { answer: "planned", date: shown?.answer === "planned" ? shown.date : (saved ?? "") },
						});
					}}
					title="We have a target date"
				/>
				{shown?.answer === "planned" ? (
					<div className="rounded-card border border-line bg-surface-raised px-[18px] py-4">
						<Field label="Launch date" error={problem ?? undefined}>
							<Input
								type="date"
								name="launchDate"
								// WebKit never matches :focus-visible on a keyboard-focused date input, so the shared ring
								// (has-[:focus-visible]) would not show. Keep the same ring on :focus here (WCAG 2.4.7).
								boxClassName="has-[:focus]:shadow-[0_0_0_1px_var(--ef-ink),0_0_0_4px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)]"
								value={shown.date}
								onChange={(e) => {
									setProblem(null);
									actions.edit({ launch: { answer: "planned", date: e.target.value } });
								}}
							/>
						</Field>
					</div>
				) : null}
				<ChoiceCard
					name="launch"
					value="no_date"
					checked={shown?.answer === "no_date"}
					onChange={() => {
						setProblem(null);
						actions.edit({ launch: { answer: "no_date" } });
					}}
					title="No date yet"
					detail={
						saved ? `Keeps the date already in the launch plan, ${longDate(saved)}.` : "Set one when you are ready."
					}
				/>
			</fieldset>
			<Notice code={state.notice?.op === "declareJourney" ? state.notice.code : null} />
			<StepFooter
				onBack={back}
				busy={busy}
				onSkip={() => save({ answer: "skip" })}
				continueLabel="Save and continue"
				onContinue={() => {
					if (!shown) return setProblem("Choose a date, or No date yet.");
					if (shown.answer === "planned" && !/^\d{4}-\d{2}-\d{2}$/.test(shown.date))
						return setProblem("Enter a launch date, like 2027-09-12.");
					save(shown);
				}}
			/>
		</section>
	);
}

/** Your team: the ordinary lead-role question (REQ-IDN-014). Yes creates only the shown role and team (R5). */
export function TeamStep({ state, actions, resume, plantName }: Props) {
	const [problems, setProblems] = useState<ReturnType<typeof leadProblems>>({});
	const [choiceProblem, setChoiceProblem] = useState<string | null>(null);
	const name = churchName(plantName);
	const back = () => actions.go(previousStep("team")!);
	if (leadLocked(resume)) {
		return (
			<section data-onboarding-step="team">
				<StepHeading title={`Who leads ${name}?`} />
				<SavedCard title="You hold the lead role">
					It is an ordinary role on your team list. Change it later from your ministry teams.
				</SavedCard>
				<StepFooter onBack={back} onContinue={() => actions.go("finish")} />
			</section>
		);
	}
	const shown = shownLead(state);
	const busy = state.pending === "answerLead";
	const edit = (lead: LeadDraft) => actions.edit({ lead });
	const save = (lead: LeadDraft) => void actions.run("answerLead", leadInput(lead));
	return (
		<section data-onboarding-step="team">
			<StepHeading title={`Will you lead ${name}?`}>
				This is a role on your team list, not a permission. You stay the Owner either way.
			</StepHeading>
			<fieldset className="mx-auto mt-[34px] grid max-w-[820px] gap-3">
				<legend className="sr-only">Who leads the church</legend>
				<ChoiceCard
					name="lead"
					value="yes"
					checked={shown?.answer === "yes"}
					onChange={() => {
						setChoiceProblem(null);
						edit({ answer: "yes", ...DEFAULT_LEAD });
					}}
					title="Yes, I lead it"
					detail="We add one lead role and assign it to you."
				/>
				{shown?.answer === "yes" ? (
					<div className="rounded-card border border-line bg-surface-raised px-[18px] py-4">
						<div className="grid gap-4 sm:grid-cols-2">
							<Field label="Role" error={problems.roleName}>
								<Input
									name="roleName"
									maxLength={200}
									value={shown.roleName}
									onChange={(e) => edit({ ...shown, roleName: e.target.value })}
								/>
							</Field>
							<Field label="Team" error={problems.teamName}>
								<Input
									name="teamName"
									maxLength={200}
									value={shown.teamName}
									onChange={(e) => edit({ ...shown, teamName: e.target.value })}
								/>
							</Field>
						</div>
						<p className="mt-3 text-sm text-text-2">
							We create the {shown.roleName.trim() || "role"} role in a new {shown.teamName.trim() || "team"} team and
							assign it to you. Nothing else is added, and no one gets new access.
						</p>
					</div>
				) : null}
				<ChoiceCard
					name="lead"
					value="no"
					checked={shown?.answer === "no"}
					onChange={() => {
						setChoiceProblem(null);
						edit({ answer: "no" });
					}}
					title="No, someone else leads it"
					detail="No role is assigned. Add your lead from your team list later."
				/>
			</fieldset>
			{choiceProblem ? (
				<p role="alert" className="mx-auto mt-4 max-w-[820px] text-sm font-medium text-magenta-600">
					{choiceProblem}
				</p>
			) : null}
			<Notice code={state.notice?.op === "answerLead" ? state.notice.code : null} />
			<StepFooter
				onBack={back}
				busy={busy}
				onSkip={() => save({ answer: "skip" })}
				continueLabel="Save and continue"
				onContinue={() => {
					if (!shown) return setChoiceProblem("Choose Yes or No, or skip for now.");
					const found = leadProblems(shown);
					setProblems(found);
					if (found.roleName || found.teamName) return;
					save(shown);
				}}
			/>
		</section>
	);
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid gap-1 border-t border-line py-3 first:border-t-0 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
			<dt className="text-sm text-text-3">{label}</dt>
			<dd className="text-ink">{children}</dd>
		</div>
	);
}

/** Finish: stamps completion once. Missing facts stay listed before and after (REQ-IDN-015). */
export function FinishStep({
	state,
	actions,
	resume,
	plantName,
	articleCount,
	after,
}: Props & { articleCount: number; after?: ReactNode }) {
	const done = finished(resume);
	const missing = missingFacts(resume, articleCount);
	const journey = resume.journey.status === "saved" ? resume.journey.value : null;
	const lead = resume.lead.answer;
	return (
		<section data-onboarding-step="finish">
			<StepHeading title={done ? "Setup is finished" : "Ready to start?"} mood={done ? "happy" : "idle"}>
				{done
					? "You can fill in what is still missing at any time."
					: "Check your answers. Finishing saves where setup ended; nothing missing is filled in for you."}
			</StepHeading>
			<div className="mx-auto mt-[34px] max-w-[820px] rounded-card border border-line bg-surface-raised px-6 py-3 shadow-card">
				<dl>
					<Fact label="Church">{plantName ?? "Your church"}</Fact>
					<Fact label="Phase">
						Phase {resume.currentPhase}, {phaseName(resume.currentPhase)}
						<span className="block text-sm text-text-3">
							{journey?.answer === "existing"
								? "Declared at setup."
								: journey?.answer === "unsure"
									? "You weren’t sure yet. Nothing declared."
									: journey?.answer === "discerning"
										? "Still discerning. Nothing declared."
										: "Where the church started. Nothing declared."}
						</span>
					</Fact>
					<Fact label="Launch date">
						{resume.scheduledLaunchDate ? longDate(resume.scheduledLaunchDate) : "Not set"}
					</Fact>
					<Fact label="Lead">
						{lead === "yes"
							? "You hold the lead role"
							: lead === "no"
								? "Someone else leads"
								: lead === "skip"
									? "Skipped"
									: "Not answered"}
					</Fact>
				</dl>
			</div>
			{missing.length ? (
				<div className="mx-auto mt-6 max-w-[820px]">
					<h2 className="font-sans text-md font-semibold tracking-normal text-ink">Still to do</h2>
					<ul className="mt-2 flex flex-col gap-1.5 text-sm text-text-2">
						{missing.map((m) => (
							<li key={m.key} className="flex gap-2">
								<span aria-hidden="true" className="mt-[7px] size-1.5 flex-none rounded-full bg-amber-500" />
								{m.label}
							</li>
						))}
					</ul>
				</div>
			) : null}
			<Notice code={state.notice?.op === "complete" ? state.notice.code : null} />
			{done ? (
				<div className="mx-auto mt-[30px] flex max-w-[820px] flex-wrap items-center justify-between gap-3">
					<Button variant="ghost" onClick={() => actions.go("team")}>
						Review answers
					</Button>
					<Button variant="primary" asChild>
						<Link href={DASHBOARD_HREF}>Go to dashboard</Link>
					</Button>
					{after}
				</div>
			) : (
				<StepFooter
					onBack={() => actions.go("team")}
					busy={state.pending === "complete"}
					continueLabel="Finish setup"
					onContinue={() => void actions.run("complete", {})}
				/>
			)}
		</section>
	);
}
