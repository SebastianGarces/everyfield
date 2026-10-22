import { getViewer } from "@/server/request-context";
import { recordId } from "@everyfield/contracts/common";
import { followUpReader } from "@everyfield/domain/followups";
import { LockKeyIcon } from "@hugeicons/core-free-icons";
import { buttonVariants, Card, PageHeader, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { CallScreen } from "./CallScreen.tsx";
import { FollowUpsScreen, type Data, type Filter } from "./FollowUpsScreen.tsx";
import type { Outcome } from "./model.ts";
import { administers, loadCall, outcomeOf, read, taskViewer, type TaskViewer } from "./server.ts";

// The follow-up routes. The files under apps/web/src/app/(product)/(frame)/ only re-export these, so the screens, their
// data loading and their states stay in this feature folder.

type Search = Promise<Record<string, string | string[] | undefined>>;
const robots = { index: false, follow: false };
export const callMetadata: Metadata = { title: "Follow-up", robots };
export const followUpsMetadata: Metadata = { title: "Follow-ups", robots };

/** A signed-out reader goes to sign-in and comes back; an account with no plant seat sees why there is nothing here. */
async function gate(returnTo: string, title: string): Promise<{ viewer: TaskViewer } | { blocked: ReactNode }> {
	const viewer = await taskViewer();
	if (viewer) return { viewer };
	const v = await getViewer();
	if (!v || v.status === "unauthenticated") redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
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

/** /follow-ups/[taskId]: record what happened on one follow-up (REQ-MTG-022). */
export async function FollowUpCallPage({ params }: { params: Promise<{ taskId: string }> }) {
	const raw = (await params).taskId;
	const id = recordId.safeParse(raw);
	if (!id.success) notFound();
	const g = await gate(`/follow-ups/${raw}`, "Follow-up");
	if ("blocked" in g) return g.blocked;
	const { viewer } = g;
	const loaded = await read(viewer, (tx) => loadCall(tx, viewer, id.data));
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

/**
 * /tasks/follow-ups: who covers which contact (REQ-TSK-012) and the handoff of an account's follow-ups (REQ-TSK-013).
 * Owners and Admins see every contact; a Member sees the follow-ups they own.
 */
export async function FollowUpsPage({ searchParams }: { searchParams: Search }) {
	const s = await searchParams;
	const filter = (FILTERS as readonly string[]).includes(one(s.show) ?? "") ? (one(s.show) as Filter) : "any";
	const page = Math.max(1, Math.min(100_000, Number.parseInt(one(s.page) ?? "1", 10) || 1));
	const g = await gate("/tasks/follow-ups", "Follow-ups");
	if ("blocked" in g) return g.blocked;
	const { viewer } = g;
	const admin = administers(viewer);
	const loaded = await read(viewer, async (tx): Promise<Outcome<Data>> => {
		if (!admin) {
			const own = (p: number) =>
				followUpReader.listFollowUpOwners(tx, viewer.authority, { owner: viewer.accountId, page: p, limit: 50 });
			let mine = outcomeOf(await own(page));
			// A page past the end shows the last page (D67).
			if (mine.status === "ok" && mine.value.items.length === 0 && page > 1)
				mine = outcomeOf(await own(Math.max(1, Math.ceil(mine.value.matched / 50))));
			return mine.status === "ok" ? { status: "ok", value: { kind: "mine", owners: mine.value } } : mine;
		}
		let r = outcomeOf(
			await followUpReader.followUpCoverage(tx, viewer.authority, { coverage: filter, page, limit: 24 }),
		);
		// A page past the end shows the last page (D67).
		if (r.status === "ok" && r.value.items.length === 0 && page > 1) {
			const last = Math.max(1, Math.ceil(r.value.total / 24));
			r = outcomeOf(
				await followUpReader.followUpCoverage(tx, viewer.authority, { coverage: filter, page: last, limit: 24 }),
			);
		}
		return r.status === "ok" ? { status: "ok", value: { kind: "coverage", coverage: r.value } } : r;
	});
	if (loaded.status !== "ok")
		return (
			<Blocked title="Follow-ups">
				<StatePanel tone="error" title="We could not load follow-ups" headingLevel="h2">
					This is a loading problem, not an empty list. Reload the page in a moment.
				</StatePanel>
			</Blocked>
		);
	return <FollowUpsScreen data={loaded.value} filter={filter} accountId={viewer.accountId} />;
}
