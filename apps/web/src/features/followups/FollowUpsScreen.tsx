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
import { forgetOwners, loadCoverage, prefetchOwners, prefetchSeats, seedOwners, warmOn } from "./fetch.ts";
import { HandoffDialog, useHandoff } from "./HandoffDialog.tsx";
import {
	COVERAGE_PAGE,
	coverageOf,
	problemText,
	totalsAfter,
	type Coverage,
	type Account,
	type DutyItem,
	type Owners,
	type Totals,
} from "./model.ts";

const COVERAGE_LABEL = { owned: "Owned", needs_owner: "Needs owner", uncovered: "No follow-up" } as const;
import { useOpener } from "./parts.tsx";
import { SaveNotice, useSaveIntent } from "../../components/save/parts.tsx";

export type Filter = "needs_owner" | "uncovered" | "owned" | "any";
export type Data =
	{ kind: "coverage"; coverage: Coverage; owners: Account[] | null } | { kind: "mine"; owners: Owners };
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
				<Coverage
					key={`${filter}:${data.coverage.page}`}
					coverage={data.coverage}
					owners={data.owners}
					filter={filter}
				/>
			) : (
				<Mine owners={data.owners} accountId={accountId} />
			)}
		</>
	);
}

function Coverage({ coverage, owners, filter }: { coverage: Coverage; owners: Account[] | null; filter: Filter }) {
	// The page brought the eligible owners: Assign and Add follow-up use them without another read.
	useState(() => owners && seedOwners(owners));
	const router = useRouter();
	const path = usePathname();
	const [rows, setRows] = useState<Row[]>(coverage.items);
	const [totals, setTotals] = useState<Totals>(coverage);
	const [moved, setMoved] = useState("");
	const [adding, setAdding] = useState<Row["person"] | null>(null);
	const [handoffOpen, setHandoffOpen] = useState(false);
	const opener = useOpener();
	const lane = useSaveIntent({ explain: problemText });
	const go = (show: Filter, page = 1) => {
		const q = new URLSearchParams();
		if (show !== "any") q.set("show", show);
		if (page > 1) q.set("page", String(page));
		router.push(`${path}${q.size ? `?${q}` : ""}`);
	};
	/** A follow-up as shown in its contact's row: at once, from an answer, or back after a refusal. */
	const change = (d: DutyItem) =>
		setRows((all) =>
			all.map((r) => {
				if (r.person.id !== d.person.id) return r;
				const duties = r.duties.some((x) => x.taskId === d.taskId)
					? r.duties.map((x) => (x.taskId === d.taskId ? d : x))
					: [...r.duties, d];
				return { ...r, duties, coverage: coverageOf(duties) };
			}),
		);
	/**
	 * After the server confirmed a change: the totals follow it, and a contact that no longer matches the chosen view
	 * leaves the list, with a status line that says where it went.
	 */
	function confirmed(moves: Parameters<typeof totalsAfter>[1]) {
		setTotals((t) => totalsAfter(t, moves));
		if (filter === "any") return;
		setRows((all) => {
			const gone = all.filter((r) => coverageOf(r.duties) !== filter);
			if (gone.length)
				setMoved(
					`${gone.map((r) => r.person.label).join(", ")} moved to ${COVERAGE_LABEL[coverageOf(gone[0]!.duties)]}.`,
				);
			return all.filter((r) => coverageOf(r.duties) === filter);
		});
	}
	/**
	 * After a refusal because a row was out of date: this view's rows, revisions and totals as the server has them now
	 * (C58 rule 6). A failed read leaves the screen as it is; the refusal notice already says what happened.
	 */
	async function reload() {
		const r = await loadCoverage(filter, coverage.page);
		if (r.status !== "ok") return;
		setRows(r.value.items);
		setTotals(r.value);
	}
	const handoff = useHandoff((r, plan) => {
		forgetOwners();
		const byId = new Map(plan.duties.map((d) => [d.taskId, d]));
		const revisions = new Map(r.moved.map((m) => [m.taskId, m.revision]));
		setRows((all) =>
			all.map((row) => {
				const duties = row.duties.map((d) =>
					revisions.has(d.taskId)
						? { ...d, owner: r.to, formerOwner: null, revision: revisions.get(d.taskId) ?? d.revision }
						: d,
				);
				return { ...row, duties, coverage: coverageOf(duties) };
			}),
		);
		const former = plan.from.eligible
			? null
			: { accountId: plan.from.accountId, displayName: plan.from.displayName ?? "" };
		confirmed(r.moved.map((m) => ({ from: byId.get(m.taskId)?.owner ?? null, to: r.to, former })));
	});
	const pageCount = Math.max(1, Math.ceil(coverage.total / COVERAGE_PAGE));
	return (
		<>
			<PageHeader
				size="xl"
				title="Follow-ups"
				subtitle="Who reaches out to whom. A contact with no follow-up is not late work."
				actions={
					<Button
						variant="secondary"
						icon={ArrowDataTransferHorizontalIcon}
						onClick={(e) => {
							opener.mark(e);
							setHandoffOpen(true);
						}}
						{...warmOn(prefetchSeats)}
					>
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
							{ value: "needs_owner", label: "Needs owner", count: totals.needsOwner },
							{ value: "uncovered", label: "No follow-up", count: totals.uncovered },
							{ value: "owned", label: "Owned" },
						]}
						className="max-app-sm:w-full"
					/>
					<SaveNotice {...lane.noticeProps} dialogOpen={adding !== null} className="" />
					<SaveNotice {...handoff.lane.noticeProps} dialogOpen={handoffOpen} className="" />
					<p role="status" className="text-sm text-text-2 empty:hidden">
						{moved}
					</p>
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
												onClick={(e) => {
													opener.mark(e);
													setAdding(r.person);
												}}
												{...warmOn(prefetchOwners)}
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
														onSaved={(before, after) =>
															confirmed([{ from: before.owner, to: after.owner, former: before.formerOwner }])
														}
														onConflict={reload}
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
					{totals.owners.length === 0 ? (
						<p className="text-sm text-text-3">No one owns an open follow-up yet.</p>
					) : (
						<ul className="flex flex-col">
							{totals.owners.map((o) => (
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
					{totals.formerOwners.length ? (
						<div className="mt-2 border-t border-line pt-3">
							<h3 className="text-sm font-semibold text-ink-2">Waiting for a handoff</h3>
							<p className="mt-0.5 text-xs text-text-3">
								They hold open follow-ups but can no longer own them. Their follow-ups show as Needs owner.
							</p>
							<ul className="mt-1 flex flex-col">
								{totals.formerOwners.map((o) => (
									<li
										key={o.accountId}
										className="flex items-center justify-between gap-3 border-t border-line py-2.5 first:border-t-0"
									>
										<span className="min-w-0">
											<span className="block text-ink">{o.displayName || "A former member"}</span>
											<span className="text-sm text-text-2 tabular-nums">{o.open} open</span>
										</span>
										<Button
											size="sm"
											variant="outline"
											aria-label={`Hand off ${o.displayName || "a former member"}’s follow-ups`}
											disabled={handoff.lane.wait !== null}
											onClick={(e) => {
												opener.mark(e);
												handoff.start(o.accountId);
												setHandoffOpen(true);
											}}
											{...warmOn(prefetchSeats)}
										>
											Hand off
										</Button>
									</li>
								))}
							</ul>
						</div>
					) : null}
					<p className="text-xs text-text-3">
						Owners need a seat and a core group, launch team or leader stage. Anyone who loses that shows as Needs
						owner.
					</p>
				</Card>
			</div>
			{adding ? (
				<AddFollowUpDialog
					returnFocus={opener.returnFocus}
					person={adding}
					lane={lane}
					onClose={() => setAdding(null)}
					onCreated={(d) => {
						const first = rows.find((r) => r.person.id === d.person.id)?.duties.length === 0;
						change(d);
						confirmed([{ from: "new", to: d.owner, firstForContact: first }]);
					}}
				/>
			) : null}
			{handoffOpen ? (
				<HandoffDialog
					returnFocus={opener.returnFocus}
					h={handoff}
					former={totals.formerOwners}
					onClose={() => {
						setHandoffOpen(false);
						handoff.closed();
					}}
				/>
			) : null}
		</>
	);
}

/** The follow-ups a Member owns, 50 to a page, with the pages in the address (D67). */
function Mine({ owners }: { owners: Owners; accountId: string }) {
	const router = useRouter();
	const path = usePathname();
	const pageCount = Math.max(1, Math.ceil(owners.matched / 50));
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
				<div className="flex flex-wrap items-center justify-between gap-3">
					<span className="text-sm text-text-3">
						{owners.matched} open {owners.matched === 1 ? "follow-up" : "follow-ups"}
					</span>
					<Pagination
						page={owners.page}
						pageCount={pageCount}
						onPageChange={(p) => router.push(p > 1 ? `${path}?page=${p}` : path)}
					/>
				</div>
			</Card>
		</>
	);
}
