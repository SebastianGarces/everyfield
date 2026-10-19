import { LockKeyIcon, UserSearch01Icon } from "@hugeicons/core-free-icons";
import { personRequest } from "@everyfield/contracts/people";
import { buttonVariants, Card, EmptyState, PageHeader, Skeleton, StatePanel } from "@everyfield/ui/controls";
import { TableSkeleton } from "@everyfield/ui/display";
import { parseTheme, ProductRoot, THEME_COOKIE } from "@everyfield/ui/foundations";
import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { parseQuery, querySearch } from "./model.ts";
import { PeopleFrame } from "./PeopleFrame.tsx";
import { PeopleScreen } from "./PeopleScreen.tsx";
import { PersonScreen } from "./PersonScreen.tsx";
import { canWrite, loadPeople, loadPerson, getViewer, type Viewer } from "./server.ts";

// The People routes. The files under apps/web/src/app/(product)/people/ only re-export these, so the screens, their
// data loading and their states stay in this feature folder.

type Search = Promise<Record<string, string | string[] | undefined>>;
const params = (raw: Record<string, string | string[] | undefined>) => {
	const out = new URLSearchParams();
	for (const [k, v] of Object.entries(raw)) for (const one of [v ?? []].flat()) out.append(k, one);
	return out;
};

/** The product root and frame for every People page, so loading and error states also sit inside the frame. */
export async function PeopleLayout({ children }: { children: ReactNode }) {
	const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
	const v = await getViewer();
	return (
		<ProductRoot initialTheme={theme}>
			<Frame viewer={v.status === "viewer" ? v.viewer : null}>{children}</Frame>
		</ProductRoot>
	);
}

/** The frame with the viewer's own name. The own account person is the name source; no other account is read. */
async function Frame({ viewer, children }: { viewer: Viewer | null; children: ReactNode }) {
	return (
		<PeopleFrame name={viewer?.displayName ?? "You"} role={viewer?.role ?? null}>
			{children}
		</PeopleFrame>
	);
}

/** Signed out goes to sign-in and comes back; no seat in a plant sees a lock; a broken setup sees an error. */
async function gate(returnTo: string): Promise<{ viewer: Viewer } | { blocked: ReactNode }> {
	const v = await getViewer();
	if (v.status === "signed_out") redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
	if (v.status === "viewer") return { viewer: v.viewer };
	return {
		blocked: (
			<>
				<PageHeader size="xl" title="People" />
				<Card>
					{v.status === "no_access" ? (
						<StatePanel tone="lock" icon={LockKeyIcon} title="People is not part of your seat" headingLevel="h2">
							People belongs to a church plant workspace. Your account has no current seat in one, so there is nothing
							to show here.
						</StatePanel>
					) : (
						<StatePanel tone="error" title="We could not load your people" headingLevel="h2">
							This is a loading problem, not an empty list. Your people are safe. Try again in a moment.
						</StatePanel>
					)}
				</Card>
			</>
		),
	};
}

export const peopleMetadata: Metadata = { title: "People", robots: { index: false, follow: false } };
export async function PeoplePage({ searchParams }: { searchParams: Search }) {
	const query = parseQuery(params(await searchParams));
	const g = await gate("/people" + querySearch(query));
	if ("blocked" in g) return g.blocked;
	const { viewer } = g;

	return <PeopleScreen loaded={await loadPeople(viewer, query)} canWrite={canWrite(viewer)} />;
}

export const personMetadata: Metadata = { title: "Person", robots: { index: false, follow: false } };
export async function PersonPage({ params }: { params: Promise<{ personId: string }> }) {
	const raw = (await params).personId;
	const g = await gate(`/people/${encodeURIComponent(raw)}`);
	if ("blocked" in g) return g.blocked;
	const { viewer } = g;
	const parsed = personRequest.safeParse({ personId: raw });
	if (!parsed.success) notFound();
	const { personId } = parsed.data;

	const loaded = await loadPerson(viewer, personId);
	if (loaded.status === "failed") return failed();
	if (loaded.status === "refused") {
		if (loaded.error.code !== "unavailable" && loaded.error.code !== "invalid_input") return failed();
		notFound();
	}
	const { found, activities, link, survivor } = loaded.value;
	if (found.status !== "available" || !("stage" in found.person)) notFound();
	const person = found.person;

	return (
		<PersonScreen
			person={person}
			activities={
				activities?.status === "ok"
					? { status: "ok", value: activities.value }
					: activities?.status === "refused"
						? { status: "refused", code: activities.error.code }
						: { status: "lost" }
			}
			linked={link?.status === "ok" && link.value.status === "linked"}
			isYou={viewer.ownPersonId === person.id}
			survivor={
				survivor?.status === "ok" && survivor.value.status === "available"
					? { id: survivor.value.person.id, name: survivor.value.person.displayName }
					: null
			}
			accountId={viewer.accountId}
			canWrite={canWrite(viewer)}
		/>
	);
}

function failed() {
	return (
		<>
			<PageHeader title="Person" breadcrumb={[{ label: "People", href: "/people" }, { label: "Person" }]} />
			<Card>
				<StatePanel tone="error" title="This person did not load" headingLevel="h2">
					This is a loading problem. Nothing was changed. Reload the page in a moment.
				</StatePanel>
			</Card>
		</>
	);
}

/** A person who is not here: missing, retired out of reach, in another church or a malformed link all read the same. */
export function PersonNotFound() {
	return (
		<>
			<PageHeader
				title="Person not found"
				breadcrumb={[{ label: "People", href: "/people" }, { label: "Not found" }]}
			/>
			<Card>
				<EmptyState
					icon={UserSearch01Icon}
					title="This person is not here"
					headingLevel="h2"
					action={
						<Link href="/people" className={buttonVariants({ variant: "primary" })}>
							Back to People
						</Link>
					}
				>
					The link may be old, or the person belongs to another church.
				</EmptyState>
			</Card>
		</>
	);
}

/** The first paint while a People page loads: the list's shape, not a spinner. */
export function PeopleLoading() {
	return (
		<div aria-busy="true" className="flex flex-col gap-6">
			<span className="sr-only" role="status">
				Loading people
			</span>
			<Skeleton className="h-14 w-60 rounded-[14px]" />
			<Card className="gap-4">
				<div className="flex flex-wrap gap-3">
					<Skeleton className="h-11 w-[320px] max-w-full rounded-[14px]" />
					<Skeleton className="h-11 w-28 rounded-[14px]" />
					<Skeleton className="h-11 w-28 rounded-[14px]" />
				</div>
				<TableSkeleton rows={6} />
			</Card>
		</div>
	);
}
