import { personId } from "@everyfield/contracts/common";
import { buttonVariants, Card, IntentLink, PageHeader, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { gate } from "../routes.tsx";
import { canWrite, read } from "../server.ts";
import { DuplicatesScreen } from "./DuplicatesScreen.tsx";
import { pairHref } from "./model.ts";
import { readPair } from "./server.ts";

export const duplicatesMetadata: Metadata = { title: "Possible duplicate", robots: { index: false, follow: false } };
const crumbs = [{ label: "People", href: "/people" }, { label: "Possible duplicate" }];

/**
 * /people/duplicates?person=<id>&with=<id>[&keep=<id>]: one pair of possible duplicates, reviewed side by side.
 * Owners and Admins review and merge; a Member sees why the page is closed to them. Without a pair the page says where
 * possible duplicates show.
 */
export async function DuplicatesPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const raw = await searchParams;
	const one = (k: string) => {
		const v = raw[k];
		const parsed = personId.safeParse(typeof v === "string" ? v : undefined);
		return parsed.success ? parsed.data : null;
	};
	const q = { person: one("person"), with: one("with"), keep: one("keep") };
	const g = await gate(q.person && q.with ? pairHref(q.person, q.with, q.keep ?? undefined) : "/people/duplicates");
	if ("blocked" in g) return g.blocked;
	const { viewer } = g;
	if (!canWrite(viewer))
		return (
			<Closed title="Only Owners and Admins can merge people">
				Ask an Owner or Admin of your church to review possible duplicates. You still see each person&rsquo;s possible
				duplicates on their page.
			</Closed>
		);
	if (!q.person || !q.with)
		return (
			<Closed title="Choose a person first">
				Possible duplicates show on each person&rsquo;s page. Open a person and choose Review next to a possible
				duplicate.
			</Closed>
		);
	const pair = { person: q.person, with: q.with, keep: q.keep };
	const r = await read(viewer, async (tx, ctx) => ({ status: "ok", value: await readPair(tx, ctx, pair) }));
	return <DuplicatesScreen initial={r.status === "ok" ? r.value : { kind: "failed" }} query={pair} />;
}

function Closed({ title, children }: { title: string; children: ReactNode }) {
	return (
		<>
			<PageHeader title="Possible duplicate" breadcrumb={crumbs} />
			<Card>
				<StatePanel
					tone="lock"
					title={title}
					actions={
						<IntentLink href="/people" className={buttonVariants({ variant: "primary" })}>
							Back to People
						</IntentLink>
					}
				>
					{children}
				</StatePanel>
			</Card>
		</>
	);
}
