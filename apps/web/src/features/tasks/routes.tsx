import { getViewer } from "@/server/request-context";
import { LockKeyIcon } from "@hugeicons/core-free-icons";
import { recordId } from "@everyfield/contracts/common";
import { Card, PageHeader, Skeleton, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { parseQuery, querySearch } from "./model.ts";
import { loadTasksPage, taskViewer } from "./server.ts";
import { TasksScreen } from "./TasksScreen.tsx";

// The Tasks route. apps/web/src/app/(product)/(frame)/tasks/ only re-exports these, so the screen, its data loading
// and its states stay in this feature folder.

type Search = Promise<Record<string, string | string[] | undefined>>;
const params = (raw: Record<string, string | string[] | undefined>) => {
	const out = new URLSearchParams();
	for (const [k, v] of Object.entries(raw)) for (const one of [v ?? []].flat()) out.append(k, one);
	return out;
};

export const tasksMetadata: Metadata = { title: "Tasks", robots: { index: false, follow: false } };

export async function TasksPage({ searchParams }: { searchParams: Search }) {
	const raw = params(await searchParams);
	const query = parseQuery(raw);
	const open = recordId.safeParse(raw.get("task"));
	const viewer = await taskViewer();
	if (!viewer) {
		const v = await getViewer();
		if (!v || v.status === "unauthenticated") redirect(`/signin?returnTo=${encodeURIComponent("/tasks" + querySearch(query))}`);
		return (
			<Blocked>
				<StatePanel tone="lock" icon={LockKeyIcon} title="Tasks are not part of your seat" headingLevel="h2">
					Tasks belong to a church plant workspace. Your account has no current seat in one, so there is nothing to show
					here.
				</StatePanel>
			</Blocked>
		);
	}
	const loaded = await loadTasksPage(viewer, query, open.success ? open.data : null);
	if (loaded.status !== "ok")
		return (
			<Blocked>
				<StatePanel tone="error" title="We could not load your tasks" headingLevel="h2">
					This is a loading problem, not an empty list. Your tasks are safe. Reload the page in a moment.
				</StatePanel>
			</Blocked>
		);
	return (
		<TasksScreen
			loaded={loaded.value}
			viewer={{ accountId: viewer.accountId, role: viewer.role, name: (await getViewer())?.displayName ?? null }}
			year={new Date().getUTCFullYear()}
		/>
	);
}

function Blocked({ children }: { children: React.ReactNode }) {
	return (
		<>
			<PageHeader size="xl" title="Tasks" />
			<Card>{children}</Card>
		</>
	);
}

/** The first paint while Tasks loads: the list's shape, not a spinner. */
export function TasksLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-6">
			<span className="sr-only" role="status">
				Loading tasks
			</span>
			<Skeleton className="h-14 w-60 rounded-card" />
			<div className="grid grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] items-start gap-5 max-app-md:grid-cols-1">
				<Card className="gap-4">
					<div className="flex flex-wrap gap-3">
						<Skeleton className="h-10 w-[280px] max-w-full rounded-md" />
						<Skeleton className="h-10 w-28 rounded-md" />
						<Skeleton className="h-10 w-28 rounded-md" />
					</div>
					{[0, 1, 2, 3, 4].map((i) => (
						<div key={i} className="flex items-center gap-3.5 px-3 py-3.5">
							<Skeleton className="size-5 rounded-full" />
							<div className="flex flex-1 flex-col gap-2">
								<Skeleton className="h-4 w-2/3" />
								<Skeleton className="h-3 w-1/3" />
							</div>
							<Skeleton className="size-7 rounded-full" />
						</div>
					))}
				</Card>
				<Skeleton className="h-60 rounded-card max-app-md:hidden" />
			</div>
		</div>
	);
}
