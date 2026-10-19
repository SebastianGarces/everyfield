import { parseTheme, ProductRoot, THEME_COOKIE } from "@everyfield/ui/foundations";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Card } from "@everyfield/ui/controls";
import { NotAvailable } from "../access/AccessStates";
import {
	namesFor,
	residencyLinks,
	runOperation,
	scopeOf,
	subjectFacts,
	targetsFor,
	viewerOf,
} from "@/server/organizations";
import * as C from "@everyfield/contracts/organizations";
import { RealRespond } from "./RealRespond";
import { RealSharing, type SharingPageData } from "./RealSharing";

// The real organization routes. apps/web/src/app/{settings/sharing,connections/respond} only re-export these.
// They are bare product pages inside the product root, like /onboarding, until the app shell lands.

export const sharingMetadata: Metadata = { title: "Sharing and privacy", robots: { index: false, follow: false } };
export const respondMetadata: Metadata = { title: "Connection request", robots: { index: false, follow: false } };

async function Frame({ children }: { children: React.ReactNode }) {
	const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
	return <ProductRoot initialTheme={theme}>{children}</ProductRoot>;
}

export async function SharingPage() {
	const who = await viewerOf();
	if (who.kind === "signed_out") redirect("/signin?returnTo=%2Fsettings%2Fsharing");
	const refused = (
		<Frame>
			<div className="px-4 py-12">
				<Card className="mx-auto max-w-[560px]">
					<NotAvailable scope="page" homeHref="/onboarding" />
				</Card>
			</div>
		</Frame>
	);
	if (who.kind !== "viewer")
		return (
			<Frame>
				<div className="px-4 py-12">
					<Card className="mx-auto max-w-[560px]">
						<NotAvailable scope="page" homeHref="/onboarding" />
					</Card>
				</div>
			</Frame>
		);
	const { mount: m, viewer } = who;
	// A seatless account without a Discovery profile has only its own residency links here.
	if (viewer.kind === "account" && (await residencyLinks(m.db, viewer)).length === 0) return refused;
	const first =
		viewer.kind === "account"
			? ({ status: "refused", code: "unavailable" } as const)
			: await runOperation(m, viewer, "associations.getHistory", scopeOf(viewer));
	const history = first.status === "ok" ? C.relationshipHistoryResult.parse(first.value) : null;
	const active = history && history.status === "available" ? history.activeRelationships : [];
	const activeOrgs = new Set(
		active
			.filter((r) => viewer.kind !== "sending_church" || r.pair.kind === "sending_church")
			.map((r) => r.pair.organization.id),
	);
	const networks =
		viewer.kind === "sending_church"
			? active.filter((r) => r.pair.kind === "sending_church" && r.pair.subject.id === viewer.selected.id)
			: [];
	const [facts, targets, residencies, names, aggregate] = await Promise.all([
		subjectFacts(m.db, viewer),
		viewer.canManage ? targetsFor(m.db, viewer, activeOrgs) : Promise.resolve([]),
		residencyLinks(m.db, viewer),
		namesFor(
			m.db,
			viewer,
			networks.map((n) => n.pair.organization.id),
		),
		viewer.kind === "sending_network" && viewer.selected.kind === "organization"
			? runOperation(m, viewer, "pipelineSharing.checkAggregateAccess", { network: viewer.selected })
			: Promise.resolve(null),
	]);
	const data: SharingPageData = {
		kind: viewer.kind,
		canManage: viewer.canManage,
		zone: facts.zone,
		revision: facts.revision,
		names,
		targets,
		networks: networks.map((n) => ({ relationshipId: n.id, name: names[n.pair.organization.id] ?? "Network" })),
		aggregate: aggregate && aggregate.status === "ok" ? C.pipelineAggregateAccessResult.parse(aggregate.value) : null,
		residencies,
	};
	return (
		<Frame>
			<RealSharing data={data} />
		</Frame>
	);
}

type Search = Promise<Record<string, string | string[] | undefined>>;
export async function RespondPage({ searchParams }: { searchParams: Search }) {
	const raw = (await searchParams).invitation;
	return (
		<Frame>
			<RealRespond invitationId={typeof raw === "string" ? raw : null} />
		</Frame>
	);
}
