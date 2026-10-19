"use client";

import {
	pipelineConsentRequest,
	setPipelineConsentRequest,
	type pipelineAggregateAccessResult,
	type pipelineConsentResult,
} from "@everyfield/contracts/organizations";
import { ChartBarLineIcon } from "@hugeicons/core-free-icons";
import { Button, Card, CardIcon, Skeleton, Switch } from "@everyfield/ui/controls";
import { LoadableView, StatusBadge } from "@everyfield/ui/display";
import { useCallback, useState } from "react";
import type { z } from "zod";
import { NotAvailable } from "../access/AccessStates";
import { useIntent, useLoad } from "./intent";
import { PrivateLine, ProblemLine } from "./parts";
import type { Run } from "./port";

type Consent = z.infer<typeof pipelineConsentResult>;

/**
 * A sending church's pipeline totals opt-in for one network connection (REQ-MUL-016). It is off until an Owner or
 * Admin turns it on, and it applies to this one network only. Turning it off stops sharing at once.
 */
export function PipelineTotals({
	relationshipId,
	networkName,
	canManage,
	run,
}: {
	relationshipId: string;
	networkName: string;
	canManage: boolean;
	run: Run;
}) {
	const fetch = useCallback(
		() => run("pipelineSharing.readConsent", pipelineConsentRequest.parse({ relationshipId })),
		[relationshipId, run],
	);
	const { state, reload: load } = useLoad(fetch, "Pipeline sharing did not load");

	return (
		<Card as="section" aria-labelledby={`pipeline-${relationshipId}`}>
			<div className="flex items-center gap-3">
				<CardIcon icon={ChartBarLineIcon} tone="violet" size={36} />
				<div className="min-w-0 flex-1">
					<h3 id={`pipeline-${relationshipId}`} className="font-semibold text-ink">
						Pipeline totals for {networkName}
					</h3>
					<p className="text-sm text-text-3">Off unless you turn it on. It applies to {networkName} only.</p>
				</div>
			</div>
			<LoadableView
				state={state}
				empty={{ title: "" }}
				loadingLabel={`Loading pipeline sharing with ${networkName}`}
				skeleton={<Skeleton shape="line" height={28} className="mt-4" />}
			>
				{(data) =>
					data.status === "unavailable" ? (
						<NotAvailable scope="section" />
					) : (
						<ConsentSwitch
							key={data.revision}
							data={data}
							networkName={networkName}
							canManage={canManage}
							run={run}
							reload={load}
						/>
					)
				}
			</LoadableView>
		</Card>
	);
}

function ConsentSwitch({
	data,
	networkName,
	canManage,
	run,
	reload,
}: {
	data: Extract<Consent, { status: "available" }>;
	networkName: string;
	canManage: boolean;
	run: Run;
	reload: () => void;
}) {
	const save = useIntent<ReturnType<typeof setPipelineConsentRequest.parse>>("pipeline-consent");
	const [next, setNext] = useState<boolean | null>(null);
	const checked = next ?? data.sharePipelineTotals;

	const toggle = async (value: boolean) => {
		if (save.held || next !== null) return;
		setNext(value);
		const result = await save.run(
			"switch",
			(requestKey) =>
				setPipelineConsentRequest.parse({
					requestKey,
					expectedRevision: data.revision,
					input: { relationshipId: data.relationshipId, sharePipelineTotals: value },
				}),
			(command) => run("pipelineSharing.setConsent", command),
			(r) => r.status === "committed",
		);
		// On success the switch re-mounts on the new revision; until then it keeps the saved value.
		if (result.ok) reload();
		else setNext(null);
	};

	return (
		<>
			<div className="mt-3 flex items-center gap-3 border-t border-line py-3">
				<div className="min-w-0 flex-1">
					<p className="font-medium text-ink">Share pipeline totals</p>
					<p className="text-sm text-text-3">
						Counts by stage, active residents, and how many were commissioned each year
					</p>
				</div>
				<StatusBadge
					status={checked ? "positive" : "unknown"}
					size="sm"
					fill="soft"
					plain
					className="max-app-sm:hidden"
				>
					{checked ? "Shared" : "Not shared"}
				</StatusBadge>
				<Switch
					checked={checked}
					onCheckedChange={toggle}
					disabled={!canManage || next !== null || save.held !== null}
					aria-label={`Share pipeline totals with ${networkName}`}
				/>
			</div>
			{canManage ? null : <p className="text-sm text-text-3">Owners and Admins choose this.</p>}
			<ProblemLine
				problem={save.problem}
				refused="Your choice was not saved. It changed somewhere else. Load the latest and try again."
				action={
					<Button
						size="sm"
						variant="secondary"
						onClick={() => {
							// Reading the latest state resolves an unconfirmed change; a new switch is a new command.
							save.release();
							reload();
						}}
					>
						Load latest
					</Button>
				}
			/>
			<p className="mt-2 text-sm text-text-2">
				{networkName} sees combined totals only when at least {data.minimumContributors} churches share. Your
				church&apos;s numbers are never shown on their own.
			</p>
			<PrivateLine>
				Names, notes, reasons, feedback, assessments and anyone&apos;s private progress are never shared.
			</PrivateLine>
		</>
	);
}

/**
 * The network's side (REQ-MUL-016, S0): only whether combined totals could be shown, never a number. Delivery of
 * the totals comes later (ADR stage 4), so this says so plainly instead of showing zero.
 */
export function PipelineAccessNote({ access }: { access: z.infer<typeof pipelineAggregateAccessResult> }) {
	return (
		<Card size="sm" as="section" aria-label="Pipeline totals from churches">
			<div className="flex items-start gap-3">
				<CardIcon icon={ChartBarLineIcon} tone="violet" size={36} />
				<div className="min-w-0 flex-1">
					<p className="font-semibold text-ink">Pipeline totals from churches</p>
					<p className="mt-1 text-text-2">
						{access.allowed
							? `At least ${access.minimumContributors} churches share pipeline totals with you. Combined totals are not shown in EveryField yet.`
							: `Fewer than ${access.minimumContributors} churches share pipeline totals with you, so nothing is shown. Totals are never shown for one church alone.`}
					</p>
				</div>
			</div>
		</Card>
	);
}
