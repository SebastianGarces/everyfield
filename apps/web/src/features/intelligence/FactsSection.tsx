"use client";

import { SIGNAL_DEFINITIONS, type PlantFacts } from "@everyfield/contracts/intelligence";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Dialog,
	DialogBody,
	DialogContent,
	DialogHeader,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
	adultsDetail,
	adultsValue,
	adultsVerdict,
	childrenNote,
	COHESION_LABEL,
	cohesionDetail,
	cohesionValue,
	contactLine,
	coverageValue,
	dayLabel,
	followUpsDetail,
	followUpsValue,
	GROWTH_LABEL,
	growthDetail,
	growthValue,
	KIND_LABEL,
	presenceLine,
	trainingDetail,
	trainingValue,
	trainingVerdict,
	VISION_LABEL,
	visionDetail,
	visionValue,
	type Verdict,
} from "./facts-model.ts";
import { renewalLabel, VALUE_LABEL } from "./signals-model.ts";

/**
 * What Everyfield has measured about the plant's progress toward launch (WP-040), with the evidence behind each number.
 * Every fact comes from the records the planter keeps; Unknown says what is missing. WP-044 later folds this section
 * into the full Plant Intelligence screen.
 */
export function FactsSection({ facts }: { facts: PlantFacts }) {
	const [evidence, setEvidence] = useState(false);
	const a = facts.committedAdults;
	return (
		<Card className="mt-5">
			<CardHeader>
				<CardHeading>
					<CardTitle>What Everyfield has measured</CardTitle>
					<CardDescription>
						From the records you keep, as of {dayLabel(facts.today)}. Unknown means the records cannot answer yet. It is
						not the same as no.
					</CardDescription>
				</CardHeading>
			</CardHeader>
			<div className="grid grid-cols-2 gap-3 max-app-md:grid-cols-1">
				<Fact
					title="Committed adults"
					value={adultsValue(a)}
					verdict={adultsVerdict(a)}
					verdictLabel="30-adult criterion"
				>
					<p>{adultsDetail(a)}</p>
					{a.needsClassifying.length ? (
						<p>
							Needs classifying:{" "}
							{a.needsClassifying.map((p, i) => (
								<span key={p.id}>
									{i ? ", " : null}
									<Link className="cursor-pointer font-medium text-ink underline" href={`/people/${p.id}`}>
										{p.name}
									</Link>
								</span>
							))}
						</p>
					) : null}
					{childrenNote(a) ? <p>{childrenNote(a)}</p> : null}
					{a.evidence.length ? (
						<Button className="mt-1 self-start" variant="outline" size="sm" onClick={() => setEvidence(true)}>
							See the {a.evidence.length} counted {a.evidence.length === 1 ? "adult" : "adults"}
						</Button>
					) : null}
				</Fact>
				<Fact title="Growth" value={growthValue(facts.growth)} verdict={GROWTH_LABEL[facts.growth.status]}>
					<p>{growthDetail(facts.growth)}</p>
				</Fact>
				<Fact title="Vision rhythm" value={visionValue(facts.vision)} verdict={VISION_LABEL[facts.vision.status]}>
					<p>{visionDetail(facts.vision)}</p>
				</Fact>
				<Fact title="Cohesion" value={cohesionValue(facts.cohesion)} verdict={COHESION_LABEL[facts.cohesion.status]}>
					<p>{cohesionDetail(facts.cohesion)}</p>
					{facts.cohesion.disengaged.length ? <p>{facts.cohesion.disengaged.map((p) => p.name).join(", ")}</p> : null}
				</Fact>
				<Fact
					title="Meeting follow-ups"
					value={followUpsValue(facts.followUps)}
					verdict={facts.followUps.status === "unknown" ? { status: "unknown", label: "Unknown" } : null}
				>
					<p>{followUpsDetail(facts.followUps)}</p>
					<p className="font-medium text-ink">{contactLine(facts.followUps)}</p>
				</Fact>
				<Fact title="Training" value={trainingValue(facts.training)} verdict={trainingVerdict(facts.training)}>
					<p>{trainingDetail(facts.training)}</p>
					{facts.training.programs.length > 1 ? (
						<ul>
							{facts.training.programs.map((g) => (
								<li key={g.id}>
									{g.name}: {g.complete} of {g.total}
								</li>
							))}
						</ul>
					) : null}
				</Fact>
			</div>
			<Coverage coverage={facts.coverage} />
			<div className="mt-3 grid grid-cols-2 gap-3 max-app-md:grid-cols-1">
				<section aria-labelledby="answers-heading" className="rounded-md bg-surface-2 px-4 py-3.5">
					<h3 id="answers-heading" className="text-sm font-semibold text-ink">
						Your answers
					</h3>
					<ul className="mt-2 flex flex-col gap-2 text-sm">
						{facts.attestations.map((x) => {
							const d = SIGNAL_DEFINITIONS.find((s) => s.key === x.key)!;
							return (
								<li key={x.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
									<span className="min-w-0 text-ink-2">{d.label}</span>
									<span className="flex flex-wrap items-center gap-2">
										<span className="text-ink">
											{x.value ? VALUE_LABEL[x.value] : x.state === "retracted" ? "Retracted" : "Not answered"}
											{x.asOf && x.value ? <span className="text-text-3"> · {dayLabel(x.asOf)}</span> : null}
										</span>
										{x.renewal.status === "needs_renewing" ? (
											<StatusBadge size="sm" status="attention">
												{renewalLabel(x.renewal)}
											</StatusBadge>
										) : null}
									</span>
								</li>
							);
						})}
					</ul>
				</section>
				<section aria-labelledby="records-heading" className="rounded-md bg-surface-2 px-4 py-3.5">
					<h3 id="records-heading" className="text-sm font-semibold text-ink">
						Interviews and 4 C&apos;s
					</h3>
					<ul className="mt-2 flex flex-col gap-1.5 text-sm text-ink-2">
						<li>
							{presenceLine(facts.humanRecords.interviews.count, facts.humanRecords.interviews.latestOn, "interview")}
						</li>
						<li>
							{presenceLine(facts.humanRecords.fourCs.count, facts.humanRecords.fourCs.latestOn, "4 C's assessment")}
						</li>
					</ul>
					<p className="mt-2 text-xs text-text-3">
						Only how many and when. Scores, notes and results stay on each person.
					</p>
				</section>
			</div>
			{evidence ? (
				<Dialog open onOpenChange={(next) => (next ? null : setEvidence(false))}>
					<DialogContent>
						<DialogHeader
							title={`${a.evidence.length} counted ${a.evidence.length === 1 ? "adult" : "adults"}`}
							description="Each adult once, with the commitment that counts them."
						/>
						<DialogBody>
							<ul className="flex flex-col divide-y divide-[var(--ef-border)] text-sm">
								{a.evidence.map((e) => (
									<li
										key={e.person.id}
										className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2"
									>
										<Link
											className="cursor-pointer font-medium text-ink hover:underline"
											href={`/people/${e.person.id}`}
										>
											{e.person.name}
										</Link>
										<span className="text-text-3">
											{e.kinds.map((k) => KIND_LABEL[k]).join(" · ")} · committed since {dayLabel(e.committedSince)}
										</span>
									</li>
								))}
							</ul>
						</DialogBody>
					</DialogContent>
				</Dialog>
			) : null}
		</Card>
	);
}

function Fact({
	title,
	value,
	verdict,
	verdictLabel,
	children,
}: {
	title: string;
	value: string;
	verdict: Verdict | null;
	verdictLabel?: string;
	children: ReactNode;
}) {
	return (
		<section aria-label={title} className="flex min-w-0 flex-col gap-1.5 rounded-md bg-surface-2 px-4 py-3.5">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="text-sm text-text-3">{title}</h3>
				{verdict ? (
					<StatusBadge size="sm" status={verdict.status}>
						{verdictLabel ? <span className="sr-only">{verdictLabel}: </span> : null}
						{verdict.label}
					</StatusBadge>
				) : null}
			</div>
			<p className="text-2xl font-semibold tabular-nums text-ink">{value}</p>
			<div className="flex flex-col gap-1 text-sm text-ink-2">{children}</div>
		</section>
	);
}

function Coverage({ coverage }: { coverage: PlantFacts["coverage"] }) {
	return (
		<section aria-labelledby="coverage-heading" className="mt-3 rounded-md bg-surface-2 px-4 py-3.5">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 id="coverage-heading" className="text-sm text-text-3">
					Ministry responsibilities
				</h3>
				<StatusBadge size="sm" status={coverage.status === "met" ? "positive" : "attention"}>
					{coverage.status === "met" ? "All eight filled" : "Not all filled"}
				</StatusBadge>
			</div>
			<p className="mt-1.5 text-2xl font-semibold tabular-nums text-ink">{coverageValue(coverage)}</p>
			<ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-4 gap-y-1 text-sm">
				{coverage.responsibilities.map((r) => (
					<li key={r.key} className="flex justify-between gap-3">
						<span className="text-ink-2">{r.label}</span>
						<span className={r.people.length ? "text-right text-ink" : "text-right text-text-3"}>
							{r.people.length ? r.people.map((p) => p.name).join(", ") : "Open"}
						</span>
					</li>
				))}
			</ul>
			<p className="mt-3 text-sm text-ink-2">
				Prayer Leader, listed separately:{" "}
				<span className="text-ink">
					{coverage.prayerLeader.length ? coverage.prayerLeader.map((p) => p.name).join(", ") : "Open"}
				</span>
			</p>
		</section>
	);
}
