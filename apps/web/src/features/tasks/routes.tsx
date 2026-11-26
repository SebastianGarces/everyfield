import { getViewer } from "@/server/request-context";
import { requireSeat } from "@/server/sign-in";
import { recordId } from "@everyfield/contracts/common";
import { Card, PageState, Skeleton } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { parseQuery, querySearch } from "./model.ts";
import { Fresh } from "./fresh.tsx";
import { loadTasksPage } from "./server.ts";
import { TasksScreen } from "./TasksScreen.tsx";
import { params } from "../../components/search-params.ts";
import { discoverySteps } from "../onboarding/mount.ts";
import { DiscoverySteps } from "./DiscoverySteps.tsx";

type Search = Promise<Record<string, string | string[] | undefined>>;
export const tasksMetadata: Metadata = { title: "Tasks", robots: { index: false, follow: false } };

export async function TasksPage({ searchParams }: { searchParams: Search }) {
	const session = await getViewer();
	if (session.discovery) return <DiscoveryStepsPage session={session} />;
	const raw = params(await searchParams);
	const query = parseQuery(raw);
	const open = recordId.safeParse(raw.get("task"));
	const viewer = await requireSeat(`/tasks${querySearch(query)}`);
	if (!viewer)
		return (
			<PageState page="Tasks" tone="lock" title="Tasks are not part of your seat">
				Tasks belong to a church plant account. You have no current seat in one, so there is nothing to show here.
			</PageState>
		);
	const loaded = await loadTasksPage(viewer, query, open.success ? open.data : null);
	if (loaded.status !== "ok")
		return (
			<PageState page="Tasks" tone="error" title="We could not load your tasks">
				This is a loading problem, not an empty list. Your tasks are safe. Reload the page in a moment.
			</PageState>
		);
	return (
		<Fresh loading={<TasksLoading />}>
			<TasksScreen
				loaded={loaded.value}
				viewer={{ accountId: viewer.accountId, role: viewer.role, name: session.displayName ?? null }}
				year={new Date().getUTCFullYear()}
			/>
		</Fresh>
	);
}

export function TasksLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-6">
			<span className="sr-only" role="status">
				Loading tasks
			</span>
			<Skeleton className="h-14 w-60" />
			<div className="grid grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] items-start gap-5 max-app-md:grid-cols-1">
				<Card className="gap-4">
					<div className="flex flex-wrap gap-3">
						<Skeleton className="h-10 w-[280px] max-w-full rounded-md" />
						<Skeleton className="h-10 w-28 rounded-md" />
						<Skeleton className="h-10 w-28 rounded-md" />
					</div>
					{[0, 1, 2, 3, 4].map((i) => (
						<div key={i} className="flex items-center gap-3.5 px-3 py-3.5">
							<Skeleton className="size-5" />
							<div className="flex flex-1 flex-col gap-2">
								<Skeleton className="h-4 w-2/3" />
								<Skeleton className="h-3 w-1/3" />
							</div>
							<Skeleton className="size-7" />
						</div>
					))}
				</Card>
				<Skeleton className="h-60 max-app-md:hidden" />
			</div>
		</div>
	);
}

async function DiscoveryStepsPage({ session }: { session: Awaited<ReturnType<typeof getViewer>> }) {
	const steps = await discoverySteps(session);
	if (!steps)
		return (
			<PageState page="Tasks" tone="error" title="Your starter steps didn't load">
				This is a loading problem. Nothing was changed. Reload the page in a moment.
			</PageState>
		);
	return <DiscoverySteps initial={steps} />;
}
