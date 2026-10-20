import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card } from "@everyfield/ui/controls";
import { NotAvailable } from "../access/AccessStates";
import {
	idsIn,
	namesFor,
	pendingFor,
	query,
	readHistory,
	readPlantSharing,
	residencyLinks,
	scopeOf,
	subjectFacts,
	targetsFor,
	viewerOf,
} from "@/server/organizations";
import { pipelineAggregateAccessRequest } from "@everyfield/contracts/organizations";
import { RealRespond } from "./RealRespond";
import { RealSharing, type SharingPageData } from "./RealSharing";

// The real organization routes. apps/web/src/app/{settings/sharing,connections/respond} only re-export these.
// /settings/sharing sits inside the product frame (WP-010); the respond page is a bare product page.

export const sharingMetadata: Metadata = { title: "Sharing and privacy", robots: { index: false, follow: false } };
export const respondMetadata: Metadata = { title: "Connection request", robots: { index: false, follow: false } };

export async function SharingPage() {
	const who = await viewerOf();
	if (who.kind === "signed_out") redirect("/signin?returnTo=%2Fsettings%2Fsharing");
	const refused = (
		<div className="py-12">
			<Card className="mx-auto max-w-[560px]">
				<NotAvailable scope="page" homeHref="/onboarding" />
			</Card>
		</div>
	);
	if (who.kind !== "viewer") return refused;
	const { mount: m, viewer } = who;
	// A seatless account without a Discovery profile has only its own residency links here.
	if (viewer.kind === "account" && (await residencyLinks(m.db, viewer)).length === 0) return refused;
	// The first connections list renders with the page: history, waiting requests, what each connection sees and names.
	const [history, pending, sharing] =
		viewer.kind === "account"
			? [null, [], {}]
			: await Promise.all([
					readHistory(m.db, who.authority, scopeOf(viewer)),
					pendingFor(m.db, viewer),
					readPlantSharing(m.db, who.authority),
				]);
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
		namesFor(m.db, viewer, [
			...(history?.status === "available" ? idsIn(history) : []),
			...pending.map((p) => p.pair.organization.id),
		]),
		viewer.kind === "sending_network" && viewer.selected.kind === "organization"
			? query(m, who.authority, viewer.selected, (tx, s, o) =>
					m.adapter["pipelineSharing.checkAggregateAccess"](
						tx,
						s,
						o,
						pipelineAggregateAccessRequest.parse({ network: viewer.selected }),
					),
				)
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
		aggregate: aggregate?.status === "ok" ? aggregate.value : null,
		residencies,
		connections: history ? { history, pending, sharing } : null,
	};
	return <RealSharing data={data} />;
}

type Search = Promise<Record<string, string | string[] | undefined>>;
export async function RespondPage({ searchParams }: { searchParams: Search }) {
	const raw = (await searchParams).invitation;
	return <RealRespond invitationId={typeof raw === "string" ? raw : null} />;
}
