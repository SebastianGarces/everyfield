"use client";

import {
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

type Consent = z.infer<typeof pipelineConsentResult>;
type SetCommand = ReturnType<typeof setPipelineConsentRequest.parse>;
/** Reads one network connection's choice: the Load latest path after an unconfirmed change. */
export type ReadConsent = (relationshipId: string) => Promise<Consent>;
/** Saves the choice. The answer is the choice as saved now, or null when nothing was saved. */
export type SaveConsent = (command: SetCommand) => Promise<Consent | null>;

/**
 * A sending church's pipeline totals opt-in for one network connection (REQ-MUL-016). It is off until an Owner or
 * Admin turns it on, and it applies to this one network only. Turning it off stops sharing at once.
 */
export function PipelineTotals({
	relationshipId,
	networkName,
	canManage,
	initial,
	read,
	save,
}: {
	relationshipId: string;
	networkName: string;
	canManage: boolean;
	/** The choice as the page read it; the card reads again only for Load latest. */
	initial?: Consent;
	read: ReadConsent;
	save: SaveConsent;
}) {
	const fetch = useCallback(() => read(relationshipId), [relationshipId, read]);
	const { state, reload, update, refreshing } = useLoad(fetch, "Pipeline sharing did not load", initial);

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
							save={save}
							onSaved={(saved) => update(() => saved)}
							onStale={reload}
							refreshing={refreshing}
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
	save: send,
	onSaved,
	onStale,
	refreshing,
}: {
	data: Extract<Consent, { status: "available" }>;
	networkName: string;
	canManage: boolean;
	save: SaveConsent;
	onSaved: (saved: Consent) => void;
	/** Read the latest state, after an unconfirmed change. */
	onStale: () => void;
	/** A fresh read is running: the revision on screen may be old, so nothing is sent until it arrives. */
	refreshing: boolean;
}) {
	const save = useIntent<SetCommand>("pipeline-consent");
	const [next, setNext] = useState<boolean | null>(null);
	const checked = next ?? data.sharePipelineTotals;

	const toggle = async (value: boolean) => {
		if (save.held || next !== null || refreshing) return;
		setNext(value);
		const result = await save.run(
			"switch",
			(requestKey) =>
				setPipelineConsentRequest.parse({
					requestKey,
					expectedRevision: data.revision,
					input: { relationshipId: data.relationshipId, sharePipelineTotals: value },
				}),
			send,
			(saved) => saved !== null,
		);
		// On success the switch re-mounts on the saved revision; until then it keeps the saved value.
		if (result.ok && result.reply) onSaved(result.reply);
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
					disabled={!canManage || next !== null || save.held !== null || refreshing}
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
							onStale();
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
							? `At least ${access.minimumContributors} churches share pipeline totals with you. Combined totals are not shown in Everyfield yet.`
							: `Fewer than ${access.minimumContributors} churches share pipeline totals with you, so nothing is shown. Totals are never shown for one church alone.`}
					</p>
				</div>
			</div>
		</Card>
	);
}
