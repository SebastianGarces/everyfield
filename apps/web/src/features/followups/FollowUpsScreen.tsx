"use client";

import { Add01Icon, ArrowDataTransferHorizontalIcon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import {
	Breadcrumb,
	Button,
	Card,
	CardHeader,
	CardHeading,
	CardTitle,
	IntentLink,
	PageHeader,
	SegmentedControl,
} from "@everyfield/ui/controls";
import { Pagination, StageChip, StatusBadge } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { STAGE_KEY, STAGE_LABEL, type StageValue } from "../people/model.ts";
import { AddFollowUpDialog, AssignMenu, DutyFacts } from "./duties.tsx";
import { forgetOwners } from "./fetch.ts";
import { HandoffDialog } from "./HandoffDialog.tsx";
import type { Coverage, DutyItem, Owners } from "./model.ts";
import { LaneNotice, useLane } from "./save.tsx";

export type Filter = "needs_owner" | "uncovered" | "owned" | "any";
export type Data = { kind: "coverage"; coverage: Coverage } | { kind: "mine"; owners: Owners };
type Row = Coverage["items"][number];

/**
 * Follow-up assignments (REQ-TSK-012, REQ-TSK-013). Owners and Admins see each contact's coverage: owned, Needs owner,
 * or no follow-up at all, which is not late work and shows no invented date. They assign, add a follow-up and hand off
 * an account's follow-ups. A Member sees the follow-ups they own.
 */
export function FollowUpsScreen({ data, filter, accountId }: { data: Data; filter: Filter; accountId: string }) {
	return (
		<>
			<Breadcrumb items={[{ label: "Tasks", href: "/tasks" }, { label: "Follow-ups" }]} className="mb-4" />
			{data.kind === "coverage" ? (
				<Coverage key={`${filter}:${data.coverage.page}`} coverage={data.coverage} filter={filter} />
			) : (
				<Mine owners={data.owners} accountId={accountId} />
			)}
		</>
	);
}

function Coverage({ coverage, filter }: { coverage: Coverage; filter: Filter }) {
	const router = useRouter();
	const path = usePathname();
	const [rows, setRows] = useState<Row[]>(coverage.items);
	const [adding, setAdding] = useState<Row["person"] | null>(null);
	const [handoff, setHandoff] = useState(false);
	const lane = useLane();
	const go = (show: Filter, page = 1) => {
		const q = new URLSearchParams();
		if (show !== "any") q.set("show", show);
		if (page > 1) q.set("page", String(page));
		router.push(`${path}${q.size ? `?${q}` : ""}`);
	};
	const change = (d: DutyItem) =>
		setRows((all) =>
			all.map((r) => {
				if (r.person.id !== d.person.id) return r;
				const duties = r.duties.some((x) => x.taskId === d.taskId)
					? r.duties.map((x) => (x.taskId === d.taskId ? d : x))
					: [...r.duties, d];
				return { ...r, duties, coverage: duties.some((x) => !x.owner) ? "needs_owner" : "owned" };
			}),
		);
	const pageCount = Math.max(1, Math.ceil(coverage.total / 24));
	return (
		<>
			<PageHeader
				size="xl"
				title="Follow-ups"
				subtitle="Who reaches out to whom. A contact with no follow-up is not late work."
				actions={
					<Button variant="secondary" icon={ArrowDataTransferHorizontalIcon} onClick={() => setHandoff(true)}>
						Hand off follow-ups
					</Button>
				}
			/>
			<div className="grid grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] items-start gap-5 max-app-lg:grid-cols-1">
				<Card className="gap-4">
					<SegmentedControl
						label="Show"
						value={filter}
						onValueChange={(v) => go(v)}
						options={[
							{ value: "any", label: "All" },
							{ value: "needs_owner", label: "Needs owner", count: coverage.needsOwner },
							{ value: "uncovered", label: "No follow-up", count: coverage.uncovered },
							{ value: "owned", label: "Owned" },
						]}
						className="max-app-sm:w-full"
					/>
					{adding ? null : <LaneNotice control={lane} className="empty:hidden" />}
					{rows.length === 0 ? (
						<p className="py-6 text-center text-sm text-text-3">
							{filter === "needs_owner"
								? "Every open follow-up has an owner."
								: filter === "uncovered"
									? "Every contact has a follow-up."
									: "No contacts to show."}
						</p>
					) : (
						<ul className="flex flex-col">
							{rows.map((r) => (
								<li key={r.person.id} className="flex flex-col gap-2 border-t border-line py-4 first:border-t-0">
									<div className="flex flex-wrap items-center gap-2">
										<IntentLink
											href={`/people/${r.person.id}`}
											className="font-semibold text-ink underline-offset-[3px] hover:underline"
										>
											{r.person.label}
										</IntentLink>
										{r.person.stage ? (
											<StageChip stage={STAGE_KEY[r.person.stage as StageValue]}>
												{STAGE_LABEL[r.person.stage as StageValue]}
											</StageChip>
										) : null}
										{r.coverage === "needs_owner" ? (
											<StatusBadge status="attention" size="sm">
												Needs owner
											</StatusBadge>
										) : null}
									</div>
									{r.duties.length === 0 ? (
										<div className="flex flex-wrap items-center justify-between gap-2">
											<span className="text-sm text-text-3">No follow-up yet.</span>
											<Button
												size="sm"
												variant="ghost"
												icon={Add01Icon}
												disabled={lane.wait !== null}
												onClick={() => setAdding(r.person)}
											>
												Add follow-up
											</Button>
										</div>
									) : (
										<ul className="flex flex-col gap-1">
											{r.duties.map((d) => (
												<li key={d.taskId} className="flex items-center gap-3 max-app-sm:flex-wrap">
													<span className="min-w-0 flex-1">
														<IntentLink
															href={`/follow-ups/${d.taskId}`}
															className="inline-flex items-center gap-1.5 text-[15px] text-ink underline-offset-[3px] hover:underline"
														>
															{d.title}
															<Icon icon={ArrowRight01Icon} size={16} className="text-text-3" />
														</IntentLink>
														<span className="mt-0.5 block">
															<DutyFacts duty={d} />
														</span>
													</span>
													<AssignMenu
														duty={d}
														lane={lane}
														canAssign
														onChange={change}
														onConflict={() => router.refresh()}
													/>
												</li>
											))}
										</ul>
									)}
								</li>
							))}
						</ul>
					)}
					<div className="flex flex-wrap items-center justify-between gap-3">
						<span className="text-sm text-text-3">
							{coverage.total} {coverage.total === 1 ? "contact" : "contacts"}
						</span>
						<Pagination page={coverage.page} pageCount={pageCount} onPageChange={(p) => go(filter, p)} />
					</div>
				</Card>
				<Card className="gap-2 max-app-lg:order-first">
					<CardHeader>
						<CardHeading>
							<CardTitle size="sm">Owners</CardTitle>
						</CardHeading>
					</CardHeader>
					{coverage.owners.length === 0 ? (
						<p className="text-sm text-text-3">No one owns an open follow-up yet.</p>
					) : (
						<ul className="flex flex-col">
							{coverage.owners.map((o) => (
								<li
									key={o.accountId}
									className="flex items-center justify-between border-t border-line py-2.5 first:border-t-0"
								>
									<span className="text-ink">{o.displayName}</span>
									<span className="text-sm text-text-2 tabular-nums">{o.open} open</span>
								</li>
							))}
						</ul>
					)}
					<p className="text-xs text-text-3">
						Owners need a seat and a core group, launch team or leader stage. Anyone who loses that shows as Needs
						owner.
					</p>
				</Card>
			</div>
			{adding ? (
				<AddFollowUpDialog person={adding} lane={lane} onClose={() => setAdding(null)} onCreated={change} />
			) : null}
			{handoff ? (
				<HandoffDialog
					onClose={() => setHandoff(false)}
					onMoved={(r) => {
						forgetOwners();
						const moved = new Map(r.moved.map((m) => [m.taskId, m.revision]));
						setRows((all) =>
							all.map((row) => {
								const duties = row.duties.map((d) =>
									moved.has(d.taskId) ? { ...d, owner: r.to, revision: moved.get(d.taskId) ?? d.revision } : d,
								);
								return {
									...row,
									duties,
									coverage: duties.length === 0 ? "uncovered" : duties.some((d) => !d.owner) ? "needs_owner" : "owned",
								};
							}),
						);
					}}
				/>
			) : null}
		</>
	);
}

function Mine({ owners }: { owners: Owners; accountId: string }) {
	return (
		<>
			<PageHeader size="xl" title="Your follow-ups" subtitle="The people you are asked to reach out to." />
			<Card className="gap-2">
				{owners.items.length === 0 ? (
					<p className="py-6 text-center text-sm text-text-3">You have no open follow-ups.</p>
				) : (
					<ul className="flex flex-col">
						{owners.items.map((d) => (
							<li key={d.taskId} className="border-t border-line py-3 first:border-t-0">
								<IntentLink
									href={`/follow-ups/${d.taskId}`}
									className="inline-flex items-center gap-1.5 font-medium text-ink underline-offset-[3px] hover:underline"
								>
									{d.person.label}
									<Icon icon={ArrowRight01Icon} size={16} className="text-text-3" />
								</IntentLink>
								<span className="mt-0.5 block text-sm text-text-2">{d.title}</span>
								<DutyFacts duty={d} />
							</li>
						))}
					</ul>
				)}
			</Card>
		</>
	);
}
