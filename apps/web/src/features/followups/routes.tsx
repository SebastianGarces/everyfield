import { requireSeat, type PlantSeat } from "@/server/request-context";
import { recordId } from "@everyfield/contracts/common";
import { followUpReader } from "@everyfield/domain/followups";
import { LockKeyIcon } from "@hugeicons/core-free-icons";
import { buttonVariants, Card, PageHeader, Skeleton, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Fresh } from "../tasks/fresh.tsx";
import { CallScreen } from "./CallScreen.tsx";
import { FollowUpsScreen, type Data, type Filter } from "./FollowUpsScreen.tsx";
import { outcomeOf, type Outcome } from "@everyfield/contracts/common";
import { readTx } from "../../server/platform/tx.ts";
import { administers, COVERAGE_PAGE, loadCall, readOwners } from "./server.ts";

type Search = Promise<Record<string, string | string[] | undefined>>;
const robots = { index: false, follow: false };
export const callMetadata: Metadata = { title: "Follow-up", robots };
export const followUpsMetadata: Metadata = { title: "Follow-ups", robots };

async function gate(returnTo: string, title: string): Promise<{ viewer: PlantSeat } | { blocked: ReactNode }> {
	const viewer = await requireSeat(returnTo);
	if (viewer) return { viewer };
	return {
		blocked: (
			<Blocked title={title}>
				<StatePanel tone="lock" icon={LockKeyIcon} title="Follow-ups are not part of your seat" headingLevel="h2">
					Follow-ups belong to a church plant workspace. Your account has no current seat in one, so there is nothing to
					show here.
				</StatePanel>
			</Blocked>
		),
	};
}

function Blocked({ title, children }: { title: string; children: ReactNode }) {
	return (
		<>
			<PageHeader size="xl" title={title} />
			<Card>{children}</Card>
		</>
	);
}
const LoadFailed = ({ title }: { title: string }) => (
	<Blocked title={title}>
		<StatePanel tone="error" title="We could not load this follow-up" headingLevel="h2">
			This is a loading problem. Nothing was changed. Reload the page in a moment.
		</StatePanel>
	</Blocked>
);

export async function FollowUpCallPage({ params }: { params: Promise<{ taskId: string }> }) {
	const raw = (await params).taskId;
	const id = recordId.safeParse(raw);
	if (!id.success) notFound();
	const g = await gate(`/follow-ups/${raw}`, "Follow-up");
	if ("blocked" in g) return g.blocked;
	const { viewer } = g;
	const loaded = await readTx("followups", (tx) => loadCall(tx, viewer, id.data));
	if (loaded.status !== "ok") return <LoadFailed title="Follow-up" />;
	if (loaded.value.kind === "missing") notFound();
	if (loaded.value.kind === "not_follow_up")
		return (
			<Blocked title="Follow-up">
				<StatePanel
					title="This task is not a follow-up with a person"
					headingLevel="h2"
					actions={
						<Link href={`/tasks?task=${loaded.value.taskId}`} className={buttonVariants({ variant: "secondary" })}>
							Open the task
						</Link>
					}
				>
					Outcomes are recorded on follow-ups that name a person. Open the task to work on it there.
				</StatePanel>
			</Blocked>
		);
	return <CallScreen initial={loaded.value.call} accountId={viewer.accountId} admin={administers(viewer)} />;
}

const FILTERS = ["needs_owner", "uncovered", "owned", "any"] as const satisfies readonly Filter[];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export async function FollowUpsPage({ searchParams }: { searchParams: Search }) {
	const s = await searchParams;
	const filter = (FILTERS as readonly string[]).includes(one(s.show) ?? "") ? (one(s.show) as Filter) : "any";
	const page = Math.max(1, Math.min(100_000, Number.parseInt(one(s.page) ?? "1", 10) || 1));
	const g = await gate("/tasks/follow-ups", "Follow-ups");
	if ("blocked" in g) return g.blocked;
	const { viewer } = g;
	const admin = administers(viewer);
	const loaded = await readTx("followups", async (tx): Promise<Outcome<Data>> => {
		if (!admin) {
			const mine = outcomeOf(
				await followUpReader.listFollowUpOwners(tx, viewer.authority, { owner: viewer.accountId, page, limit: 50 }),
			);
			return mine.status === "ok" ? { status: "ok", value: { kind: "mine", owners: mine.value } } : mine;
		}
		const r = outcomeOf(
			await followUpReader.followUpCoverage(tx, viewer.authority, { coverage: filter, page, limit: COVERAGE_PAGE }),
		);
		if (r.status !== "ok") return r;
		const owners = await readOwners(tx, viewer);
		return {
			status: "ok",
			value: { kind: "coverage", coverage: r.value, owners: owners.status === "ok" ? owners.value : null },
		};
	});
	if (loaded.status !== "ok")
		return (
			<Blocked title="Follow-ups">
				<StatePanel tone="error" title="We could not load follow-ups" headingLevel="h2">
					This is a loading problem, not an empty list. Reload the page in a moment.
				</StatePanel>
			</Blocked>
		);
	return (
		<Fresh loading={<FollowUpsLoading />}>
			<FollowUpsScreen data={loaded.value} filter={filter} />
		</Fresh>
	);
}

export function FollowUpsLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-6">
			<span className="sr-only" role="status">
				Loading follow-ups
			</span>
			<div className="flex flex-col gap-3">
				<Skeleton className="w-36" />
				<Skeleton shape="block" className="h-12 w-60" />
				<Skeleton className="w-[420px] max-w-full" />
			</div>
			<div className="grid grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] items-start gap-5 max-app-lg:grid-cols-1">
				<Card className="gap-4">
					<Skeleton shape="block" className="h-10 w-full rounded-md" />
					{[0, 1, 2, 3, 4].map((i) => (
						<div key={i} className="flex flex-col gap-2 py-4">
							<Skeleton className="w-1/3" />
							<Skeleton className="w-2/3" />
						</div>
					))}
				</Card>
				<Skeleton shape="block" className="h-40 max-app-lg:hidden" />
			</div>
		</div>
	);
}
