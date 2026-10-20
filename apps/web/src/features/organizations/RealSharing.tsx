"use client";

import type { pipelineAggregateAccessResult } from "@everyfield/contracts/organizations";
import { PageHeader } from "@everyfield/ui/controls";
import { useMemo } from "react";
import type { z } from "zod";
import { Connections, type ConnectionsData } from "./Connections";
import type { InviteTarget } from "./InviteDialog";
import { PipelineAccessNote, PipelineTotals } from "./Pipeline";
import { createNames, readResidency, readSharing, realRun, saveSharingChoice } from "./real";
import { ResidencySharing } from "./Residency";

export type SharingPageData = {
	kind: "plant" | "sending_church" | "sending_network" | "discovery" | "account";
	canManage: boolean;
	zone: string;
	revision: string;
	names: Record<string, string>;
	targets: InviteTarget[];
	/** Sending church only: its current network connections, for the pipeline totals opt-in. */
	networks: { relationshipId: string; name: string }[];
	/** Network only: whether combined pipeline totals could be shown (S0 check). */
	aggregate: z.infer<typeof pipelineAggregateAccessResult> | null;
	residencies: { linkId: string; organizationName: string }[];
	/** The connections list read with the page; null for a seatless account, which has no list. */
	connections: ConnectionsData | null;
};

const INTRO: Record<SharingPageData["kind"], string> = {
	plant: "Choose who your church works with. Names and personal details are never shared.",
	discovery: "Sending churches and networks you are connected with while you explore planting.",
	sending_church: "Churches connected with you, the networks you work with, and what you share with each.",
	sending_network: "Churches and sending churches connected with your network.",
	account: "What you share from your residency. Only you can change it.",
};

/** /settings/sharing on the real WP-007 API: connections, pipeline totals and the viewer's own residency consent. */
export function RealSharing({ data }: { data: SharingPageData }) {
	// Invite targets' names are known too, so a request sent from this page names its organization at once.
	const names = useMemo(
		() =>
			createNames({ ...data.names, ...Object.fromEntries(data.targets.map((t) => [t.pair.organization.id, t.name])) }),
		[data.names, data.targets],
	);
	const subject = data.kind === "plant" || data.kind === "discovery";
	return (
		<div className="mx-auto flex max-w-[880px] flex-col gap-6">
			<PageHeader title="Sharing and privacy" subtitle={INTRO[data.kind]} />
			{data.kind === "account" ? null : (
				<Connections
					side={subject ? "subject" : "organization"}
					load={names.load}
					initial={data.connections ?? undefined}
					readMore={names.readMore}
					canManage={data.canManage}
					nameOf={names.nameOf}
					zone={data.zone}
					run={realRun}
					end={names.end}
					readSharing={data.kind === "plant" ? { read: readSharing, save: saveSharingChoice } : undefined}
					invite={
						data.kind !== "sending_network"
							? { targets: data.targets, readDisclosure: names.readDisclosure, expectedRevision: data.revision }
							: undefined
					}
				/>
			)}
			{data.canManage
				? data.networks.map((n) => (
						<PipelineTotals
							key={n.relationshipId}
							relationshipId={n.relationshipId}
							networkName={n.name}
							canManage={data.canManage}
							run={realRun}
						/>
					))
				: null}
			{data.aggregate ? <PipelineAccessNote access={data.aggregate} /> : null}
			{data.residencies.map((r) => (
				<ResidencySharing
					key={r.linkId}
					linkId={r.linkId}
					organizationName={r.organizationName}
					read={readResidency}
					run={realRun}
				/>
			))}
		</div>
	);
}
