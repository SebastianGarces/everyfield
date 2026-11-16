"use client";

import type { pipelineAggregateAccessResult, pipelineConsentResult } from "@everyfield/contracts/organizations";
import { PageHeader } from "@everyfield/ui/controls";
import { useMemo } from "react";
import type { z } from "zod";
import { Connections, type ConnectionsData } from "./Connections";
import type { InviteTarget } from "./InviteDialog";
import { PipelineAccessNote, PipelineTotals } from "./Pipeline";
import {
	createNames,
	readConsent,
	readResidency,
	readSharing,
	realRun,
	saveConsent,
	saveResidency,
	saveSharingChoice,
} from "./real";
import { ResidencySharing, type ResidencyRow } from "./Residency";

export type SharingPageData = {
	kind: "plant" | "sending_church" | "sending_network" | "discovery" | "account";
	canManage: boolean;
	zone: string;
	revision: string;
	names: Record<string, string>;
	targets: InviteTarget[];
	pipeline: { networkName: string; consent: Extract<z.infer<typeof pipelineConsentResult>, { status: "available" }> }[];
	aggregate: z.infer<typeof pipelineAggregateAccessResult> | null;
	residencies: ({ linkId: string; organizationName: string } & ResidencyRow)[];
	connections: ConnectionsData | null;
};

const INTRO: Record<SharingPageData["kind"], string> = {
	plant: "Choose who your church works with. Names and personal details are never shared.",
	discovery: "Sending churches and networks you are connected with while you explore planting.",
	sending_church: "Churches connected with you, the networks you work with, and what you share with each.",
	sending_network: "Churches and sending churches connected with your network.",
	account: "What you share from your residency. Only you can change it.",
};

export function RealSharing({ data }: { data: SharingPageData }) {
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
			{data.pipeline.map(({ networkName, consent }) => (
				<PipelineTotals
					key={consent.relationshipId}
					relationshipId={consent.relationshipId}
					networkName={networkName}
					canManage={data.canManage}
					initial={consent}
					read={readConsent}
					save={saveConsent}
				/>
			))}
			{data.aggregate ? <PipelineAccessNote access={data.aggregate} /> : null}
			{data.residencies.map(({ linkId, organizationName, sharing, linkRevision }) => (
				<ResidencySharing
					key={linkId}
					linkId={linkId}
					organizationName={organizationName}
					initial={{ sharing, linkRevision }}
					read={readResidency}
					save={saveResidency}
					run={realRun}
				/>
			))}
		</div>
	);
}
