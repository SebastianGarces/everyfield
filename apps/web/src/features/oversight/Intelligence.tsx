"use client";

import type { IntelligenceGroup, IntelligencePattern, IntelligenceView, Level } from "@everyfield/contracts/oversight";
import { LEVELS, patternText } from "@everyfield/contracts/oversight";
import {
	AlertCircleIcon,
	ArrowRight01Icon,
	Refresh01Icon,
	ThumbsDownIcon,
	ThumbsUpIcon,
	UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { Button, CalloutLabel, CalloutText, Card, CardIcon, EmptyState } from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useState, useTransition } from "react";
import { writeAddress } from "../../components/location.ts";
import { ratePattern, refreshIntelligence } from "./actions.ts";
import { concernLenses, HEALTH, type IntelligenceWords, plural, resultLabels, runLabel } from "./model.ts";

const href = (level: Level, runId: string | null) =>
	`/network/intelligence?level=${level}${runId ? `&run=${runId}` : ""}`;

export function IntelligenceBody({ initial, words }: { initial: IntelligenceView; words: IntelligenceWords }) {
	const [view, setView] = useState(initial);
	const [problem, setProblem] = useState<string | null>(null);
	const [refreshing, startRefresh] = useTransition();
	const latest = view.history[0]?.runId ?? null;
	const viewingLatest = view.run?.runId === latest;

	const refresh = () =>
		startRefresh(async () => {
			setProblem(null);
			const answer = await refreshIntelligence(crypto.randomUUID(), view.level).catch(() => ({
				status: "lost" as const,
			}));
			if (answer.status === "ok") {
				setView(answer.view);
				writeAddress(href(answer.view.level, null), { replace: true });
			} else setProblem(answer.status === "refused" ? words.refused : words.failed);
		});

	const rate = async (pattern: IntelligencePattern, rating: "useful" | "not_useful") => {
		if (!view.run) return;
		const set = (value: IntelligencePattern["rating"]) =>
			setView((v) => ({
				...v,
				groups: v.groups.map((g) => ({
					...g,
					patterns: g.patterns.map((p) => (p.key === pattern.key ? { ...p, rating: value } : p)),
				})),
			}));
		const before = pattern.rating;
		set(rating);
		setProblem(null);
		const answer = await ratePattern({ runId: view.run.runId, patternKey: pattern.key, rating }).catch(() => ({
			status: "lost" as const,
		}));
		if (answer.status !== "ok") {
			set(before);
			setProblem("Your rating wasn't saved. Try again in a moment.");
		}
	};

	return (
		<div className="flex flex-col gap-5">
			<Card size="sm" className="flex-row flex-wrap items-center gap-x-4 gap-y-3">
				<div className="min-w-0 flex-1">
					<p className="text-sm text-text-3">{viewingLatest ? "Latest run" : "Earlier run"}</p>
					<p className="font-medium text-ink">{view.run ? runLabel(view.run.ranAt, view.timeZone) : "No run yet"}</p>
				</div>
				{view.canRefresh ? (
					<Button variant="primary" onClick={refresh} disabled={refreshing}>
						<Icon icon={Refresh01Icon} size={16} />
						{refreshing ? "Refreshing…" : "Refresh"}
					</Button>
				) : (
					<p className="text-sm text-text-3">Owners and Admins can refresh.</p>
				)}
				{problem ? (
					<p role="alert" className="flex w-full items-start gap-2 text-md text-magenta-700">
						<Icon icon={AlertCircleIcon} size={16} className="mt-0.5 flex-none" />
						{problem}
					</p>
				) : null}
			</Card>

			{view.run ? (
				<>
					<nav
						aria-label="Group by"
						className="flex w-max max-w-full gap-1 overflow-x-auto rounded-md bg-surface-2 p-1"
					>
						{LEVELS.map((l) => (
							<Link
								key={l}
								href={href(l, viewingLatest ? null : view.run!.runId)}
								aria-current={view.level === l ? "page" : undefined}
								className={cn(
									"inline-flex flex-none items-center rounded-md px-3.5 py-2 font-medium whitespace-nowrap text-ink-2 transition-colors duration-150 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ef-focus)]",
									view.level === l && "bg-surface-raised shadow-[var(--ef-shadow-raised)]",
								)}
							>
								{words.levels[l]}
							</Link>
						))}
					</nav>
					{view.level === "region" && view.geographyReleases.length ? (
						<p
							className="-mt-2 text-sm text-text-3"
							data-geography={view.geographyReleases.map((r) => r.key).join(" ")}
						>
							Regions from {view.geographyReleases.map((r) => r.credit).join("; ")}.
						</p>
					) : null}
					{view.groups.length ? (
						view.groups.map((g) => (
							<Group
								key={g.key}
								group={g.key === "portfolio" ? { ...g, label: words.levels.portfolio } : g}
								rate={rate}
								canRate={view.canRefresh}
							/>
						))
					) : (
						<Card>
							<EmptyState icon={UserGroupIcon} title="No plants in this run" headingLevel="h3">
								No plant was linked to you when this run read your portfolio.
							</EmptyState>
						</Card>
					)}
					{view.history.length > 1 ? <History view={view} /> : null}
				</>
			) : (
				<Card>
					<EmptyState icon={UserGroupIcon} title={words.notRun} headingLevel="h3">
						{view.canRefresh
							? "Press Refresh to read what your plants share now. Each run is kept, so you can look back at earlier ones."
							: "An Owner or Admin of your organization can run it. Each run is kept, so you can look back at earlier ones."}
					</EmptyState>
				</Card>
			)}
		</div>
	);
}

type Rate = (pattern: IntelligencePattern, rating: "useful" | "not_useful") => void;

function Group({ group, rate, canRate }: { group: IntelligenceGroup; rate: Rate; canRate: boolean }) {
	const shared = group.rows.filter((r) => r.status === "shared").length;
	const id = `group-${group.key.replace(/\W/g, "-")}`;
	return (
		<Card as="section" aria-labelledby={id} data-group={group.key}>
			<div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h2 id={id} className="font-title text-title-sm tracking-[-0.02em] text-ink">
					{group.label}
				</h2>
				<p className="text-sm text-text-3">
					{plural(group.rows.length, "plant")} · {shared} share findings
				</p>
			</div>
			{group.patterns.length ? (
				<div className="mb-4 flex flex-col gap-3">
					{group.patterns.map((p) => (
						<Pattern key={p.key} pattern={p} rate={rate} canRate={canRate} />
					))}
				</div>
			) : (
				<p className="mb-3 text-md text-text-2 text-pretty">
					{group.placement !== "placed"
						? "These plants have no location at this level. They still count at the larger levels."
						: "Not enough plants for a pattern here. A pattern needs at least 2 sharing plants with the same recorded result."}
				</p>
			)}
			<ul aria-label={`Plants in ${group.label}`}>
				{group.rows.map((r) => (
					<li
						key={r.plantId}
						className="border-t border-line first:border-t-0"
						data-row={r.status}
						data-plant={r.plantId}
						data-health={r.status === "shared" ? r.health : undefined}
						data-concerns={
							r.status === "shared" && r.assessment.status === "released"
								? r.assessment.concerns.map((c) => c.id).join(" ")
								: undefined
						}
					>
						<Link
							href={`/network/plants/${r.plantId}`}
							data-focus-inset=""
							className="-mx-2 flex items-center gap-3 rounded-md px-2 py-3 transition-colors hover:bg-hover"
						>
							<CardIcon icon={UserGroupIcon} tone="green" size={36} />
							<span className="flex min-w-0 flex-1 flex-col gap-1.5">
								<span className="font-medium text-ink">{r.name}</span>
								<span className="flex flex-wrap gap-1.5">
									{r.status === "shared" ? (
										<StatusBadge status={HEALTH[r.health].status} size="sm">
											{HEALTH[r.health].label}
										</StatusBadge>
									) : null}
									{resultLabels(r).map((tag) => (
										<StatusBadge key={tag.label} status={tag.status} size="sm">
											{tag.label}
										</StatusBadge>
									))}
								</span>
								{r.status === "shared" && concernLenses(r.assessment) ? (
									<span className="text-sm text-text-2">{concernLenses(r.assessment)}</span>
								) : null}
							</span>
							<Icon icon={ArrowRight01Icon} size={16} className="flex-none text-text-3" />
						</Link>
					</li>
				))}
			</ul>
		</Card>
	);
}

function Pattern({ pattern, rate, canRate }: { pattern: IntelligencePattern; rate: Rate; canRate: boolean }) {
	const text = patternText(pattern);
	return (
		<Card variant="callout" tone="amber" data-pattern={pattern.key}>
			<CalloutLabel tone="amber" icon={UserGroupIcon}>
				{text.title}
			</CalloutLabel>
			{text.lines.map((line, i) => (
				<p key={line} className={cn("text-pretty", i === 0 ? "mt-1 font-medium text-ink" : "mt-1 text-md text-ink-2")}>
					{line}
				</p>
			))}
			<ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
				{pattern.plants.map((p) => (
					<li key={p.plantId}>
						<Link
							href={`/network/plants/${p.plantId}`}
							className="font-medium text-ink underline underline-offset-[3px] hover:text-ink-2"
						>
							{p.name}
						</Link>
					</li>
				))}
			</ul>
			<CalloutText className="mt-3 text-md">
				<b className="font-semibold text-ink">Suggested next step.</b> {text.nextStep}
			</CalloutText>
			<p className="mt-1 text-sm text-text-3">{text.evidence}</p>
			{canRate ? (
				<div className="mt-3 flex flex-wrap items-center gap-2">
					<span className="text-sm text-text-2">Was this useful? Only you see your answer.</span>
					<Button
						size="sm"
						variant={pattern.rating === "useful" ? "primary" : "secondary"}
						aria-pressed={pattern.rating === "useful"}
						onClick={() => rate(pattern, "useful")}
					>
						<Icon icon={ThumbsUpIcon} size={16} />
						Useful
					</Button>
					<Button
						size="sm"
						variant={pattern.rating === "not_useful" ? "primary" : "secondary"}
						aria-pressed={pattern.rating === "not_useful"}
						onClick={() => rate(pattern, "not_useful")}
					>
						<Icon icon={ThumbsDownIcon} size={16} />
						Not useful
					</Button>
				</div>
			) : null}
		</Card>
	);
}

function History({ view }: { view: IntelligenceView }) {
	return (
		<Card as="section" aria-labelledby="history-title" size="sm">
			<h2 id="history-title" className="mb-2 font-semibold text-ink">
				Earlier runs
			</h2>
			<p className="mb-3 text-sm text-text-3">
				Each run keeps only plants that still share with you. A plant that stops sharing leaves every run.
			</p>
			<ul className="flex flex-col gap-1">
				{view.history.map((h, i) => (
					<li key={h.runId}>
						<Link
							href={href(view.level, i === 0 ? null : h.runId)}
							aria-current={view.run?.runId === h.runId ? "page" : undefined}
							className="text-md text-text-2 underline-offset-[3px] hover:text-ink hover:underline aria-[current=page]:font-medium aria-[current=page]:text-ink"
						>
							{runLabel(h.ranAt, view.timeZone)}
							{i === 0 ? " · latest" : ""}
						</Link>
					</li>
				))}
			</ul>
		</Card>
	);
}
