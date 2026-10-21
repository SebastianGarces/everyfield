import { drainPeopleImports } from "@/server/people/imports";
import { buttonVariants, Card, IntentLink, PageHeader, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { gate } from "../routes.tsx";
import { canWrite } from "../server.ts";
import { ImportScreen, type Initial } from "./ImportScreen.tsx";
import { readReceipt } from "./server.ts";

export const importMetadata: Metadata = { title: "Import people", robots: { index: false, follow: false } };

/**
 * /people/import. With ?import=<request key> it opens that import's receipt, so a reload or a lost reply never starts a
 * second import. Owners and Admins import; a Member sees why the page is closed to them.
 */
export async function ImportPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const raw = (await searchParams).import;
	const key = typeof raw === "string" ? raw : null;
	const g = await gate("/people/import" + (key ? `?import=${encodeURIComponent(key)}` : ""));
	if ("blocked" in g) return g.blocked;
	const { viewer } = g;
	if (!canWrite(viewer)) {
		return (
			<>
				<PageHeader
					size="xl"
					title="Import people"
					breadcrumb={[{ label: "People", href: "/people" }, { label: "Import" }]}
				/>
				<Card>
					<StatePanel
						tone="lock"
						title="Only Owners and Admins can import people"
						actions={
							<IntentLink href="/people" className={buttonVariants({ variant: "primary" })}>
								Back to People
							</IntentLink>
						}
					>
						Ask an Owner or Admin of your church to import the file. You can still export people from the People page.
					</StatePanel>
				</Card>
			</>
		);
	}
	let initial: Initial = { kind: "none" };
	if (key) {
		const reply = await readReceipt(viewer, key);
		if (!reply || reply.status === "refused") initial = { kind: "missing", key };
		else if (reply.status === "failed") initial = { kind: "lost", key };
		else {
			if (reply.value.status === "in_progress") drainPeopleImports();
			initial = { kind: "receipt", key, receipt: reply.value };
		}
	}
	return <ImportScreen initial={initial} />;
}
