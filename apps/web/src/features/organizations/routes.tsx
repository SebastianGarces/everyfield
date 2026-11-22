import { signIn } from "@/server/sign-in";
import type { Metadata } from "next";
import { Card } from "@everyfield/ui/controls";
import { NotAvailable } from "../access/AccessStates";
import {
	idsIn,
	namesFor,
	pendingFor,
	query,
	readHistory,
	readPipelineConsents,
	readPlantSharing,
	ownResidencyLinks,
	scopeOf,
	subjectFacts,
	targetsFor,
	viewerOf,
} from "./mount";
import { pipelineAggregateAccessRequest } from "@everyfield/contracts/organizations";
import { RealRespond } from "./RealRespond";
import { RealSharing, type SharingPageData } from "./RealSharing";

export const sharingMetadata: Metadata = { title: "Sharing and privacy", robots: { index: false, follow: false } };
export const respondMetadata: Metadata = { title: "Connection request", robots: { index: false, follow: false } };

export async function SharingPage() {
	const who = await viewerOf();
	if (who.kind === "signed_out") signIn("/settings/sharing");
	const refused = (
		<div className="py-12">
			<Card className="mx-auto max-w-[560px]">
				<NotAvailable scope="page" homeHref="/onboarding" />
			</Card>
		</div>
	);
	if (who.kind !== "viewer") return refused;
	const { mount: m, viewer } = who;
	const listed = viewer.kind !== "account";
	const [residencies, facts, targets, pipeline, aggregate, history, pending, sharing] = await Promise.all([
		ownResidencyLinks(),
		listed ? subjectFacts(m.db, viewer) : { revision: "0", zone: "UTC" },
		viewer.canManage ? targetsFor(m.db, viewer, new Set()) : Promise.resolve([]),
		readPipelineConsents(m.db, who.authority),
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
		listed ? readHistory(m.db, who.authority, scopeOf(viewer)) : null,
		listed ? pendingFor(m.db, viewer) : [],
		listed ? readPlantSharing(m.db, who.authority) : {},
	]);
	if (!listed && residencies.length === 0) return refused;
	const names = await namesFor(m.db, viewer, [
		...(history?.status === "available" ? idsIn(history) : []),
		...pending.map((p) => p.pair.organization.id),
	]);
	const data: SharingPageData = {
		kind: viewer.kind,
		canManage: viewer.canManage,
		zone: facts.zone,
		revision: facts.revision,
		names,
		targets,
		pipeline,
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
