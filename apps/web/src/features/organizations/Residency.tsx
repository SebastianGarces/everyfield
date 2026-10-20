"use client";

import {
	leaveResidencyRequest,
	residencySharingRequest,
	setResidencySharingRequest,
	type residencySharingResult,
	type residentChoices,
} from "@everyfield/contracts/organizations";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { Button, Card, CardIcon, Checkbox, ConfirmDialog, Skeleton, Spinner, Switch } from "@everyfield/ui/controls";
import { LoadableView, StatusBadge } from "@everyfield/ui/display";
import { useCallback, useId, useState } from "react";
import type { z } from "zod";
import { NotAvailable } from "../access/AccessStates";
import { useIntent, useLoad } from "./intent";
import { PrivateLine, ProblemLine } from "./parts";
import type { Run } from "./port";

type ResidentChoices = z.infer<typeof residentChoices>;
type Key = keyof ResidentChoices;
type Sharing = z.infer<typeof residencySharingResult>;

const RESIDENT_TEXT: Record<Key, { label: string; description: string }> = {
	shareFoundations: { label: "Foundation progress", description: "Which of the six foundations you have completed" },
	shareMilestones: { label: "Milestone progress", description: "The residency milestones you reach" },
};
const KEYS = Object.keys(RESIDENT_TEXT) as Key[];
const PRIVATE =
	"Your reading, notes and documents stay yours. They are never shared, and no one gets a seat in your account.";

/**
 * What a resident chooses before accepting a residency link (REQ-MUL-003). Both start unchecked: acceptance shares
 * only what the resident ticks here.
 */
export function ResidencyDisclosure({
	organizationName,
	onAccept,
}: {
	organizationName: string;
	onAccept: (choices: ResidentChoices) => void | Promise<void>;
}) {
	const [choices, setChoices] = useState<ResidentChoices>({ shareFoundations: false, shareMilestones: false });
	const [busy, setBusy] = useState(false);
	return (
		<Card as="section" aria-labelledby="residency-disclosure" className="mx-auto w-full max-w-[560px]">
			<div className="flex items-start gap-4">
				<CardIcon icon={UserGroupIcon} tone="teal" />
				<div className="min-w-0 flex-1">
					<h1 id="residency-disclosure" className="font-title text-title-md tracking-[-0.02em] text-ink">
						Join the residency at {organizationName}
					</h1>
					<p className="mt-1 text-text-2">
						Choose what {organizationName} can see about your progress. You can change this later.
					</p>
				</div>
			</div>
			<div className="mt-5 flex flex-col gap-4">
				{KEYS.map((key) => (
					<Checkbox
						key={key}
						checked={choices[key]}
						onCheckedChange={(v) => setChoices({ ...choices, [key]: v === true })}
						label={`Share ${RESIDENT_TEXT[key].label.toLowerCase()}`}
						description={RESIDENT_TEXT[key].description}
					/>
				))}
			</div>
			<PrivateLine>{PRIVATE}</PrivateLine>
			<div className="mt-6 flex justify-end">
				<Button
					variant="primary"
					loading={busy}
					onClick={async () => {
						setBusy(true);
						try {
							await onAccept(choices);
						} finally {
							setBusy(false);
						}
					}}
				>
					Accept and join
				</Button>
			</div>
		</Card>
	);
}

/**
 * A resident's own consent for one residency link (REQ-MUL-003). Each switch stops or starts one category at once;
 * leaving ends the link. A stale screen is refused, never applied over a newer choice.
 */
/**
 * The current consent and the link's own revision. Every change must carry both: the link revision on the command
 * and the consent revision inside it (REQ-MUL-003). The contract read returns only the consent revision, so the
 * caller supplies the link revision (ruling D16).
 */
export type ReadResidency = (linkId: string) => Promise<{ sharing: Sharing; linkRevision: string }>;

export function ResidencySharing({
	linkId,
	organizationName,
	read,
	run,
}: {
	linkId: string;
	organizationName: string;
	read: ReadResidency;
	run: Run;
}) {
	const titleId = useId();
	const fetch = useCallback(() => read(residencySharingRequest.parse({ linkId }).linkId), [linkId, read]);
	const { state, reload: load, refreshing } = useLoad(fetch, "Your residency sharing did not load");

	return (
		<Card as="section" aria-labelledby={titleId} className="w-full">
			<div className="flex items-center gap-3">
				<CardIcon icon={UserGroupIcon} tone="teal" size={36} />
				<div className="min-w-0 flex-1">
					<h2 id={titleId} className="font-semibold text-ink">
						Residency with {organizationName}
					</h2>
					<p className="text-sm text-text-3">Only you can change what is shared.</p>
				</div>
			</div>
			<LoadableView
				state={state}
				empty={{ title: "" }}
				loadingLabel="Loading your residency sharing"
				skeleton={
					<div className="mt-4 flex flex-col gap-3">
						<Skeleton shape="line" height={28} />
						<Skeleton shape="line" height={28} />
					</div>
				}
			>
				{({ sharing: data, linkRevision }) =>
					data.status === "unavailable" ? (
						<NotAvailable scope="section" />
					) : data.status === "ended" ? (
						<p className="mt-4 text-text-2">You left this residency. Nothing is shared with {organizationName}.</p>
					) : (
						<ActiveResidency
							key={data.consentRevision}
							data={data}
							linkRevision={linkRevision}
							organizationName={organizationName}
							run={run}
							reload={load}
							refreshing={refreshing}
						/>
					)
				}
			</LoadableView>
		</Card>
	);
}

function ActiveResidency({
	data,
	linkRevision,
	organizationName,
	refreshing,
	run,
	reload,
}: {
	data: Extract<Sharing, { status: "active" }>;
	linkRevision: string;
	organizationName: string;
	/** A fresh read is running: the revisions on screen may be old, so nothing is sent until it arrives. */
	refreshing: boolean;
	run: Run;
	reload: () => void;
}) {
	// One intent for the switches and Leave: while one command is unconfirmed, nothing else is sent.
	const save = useIntent<object>("residency");
	const [busy, setBusy] = useState<{ key: Key; value: boolean } | null>(null);

	const toggle = (key: Key) => async (value: boolean) => {
		if (save.held || busy || refreshing) return;
		setBusy({ key, value });
		const result = await save.run(
			key,
			(requestKey) =>
				setResidencySharingRequest.parse({
					requestKey,
					expectedRevision: linkRevision,
					input: {
						linkId: data.linkId,
						expectedConsentRevision: data.consentRevision,
						choices: { ...data.choices, [key]: value },
					},
				}),
			(command) => run("residency.setSharing", command),
			(r) => r.status === "committed",
		);
		// On success the card re-mounts on the new consent revision; until then the switch keeps the saved value.
		if (result.ok) reload();
		else setBusy(null);
	};

	const onLeave = async () => {
		const result = await save.run(
			"leave",
			(requestKey) =>
				leaveResidencyRequest.parse({
					requestKey,
					expectedRevision: linkRevision,
					input: { linkId: data.linkId, expectedConsentRevision: data.consentRevision },
				}),
			(command) => run("residency.leave", command),
			(r) => r.status === "committed",
		);
		if (result.ok) return reload();
		throw new Error(
			result.problem === "refused"
				? "You did not leave. Your sharing changed somewhere else. Close this and check again."
				: result.problem === "busy"
					? "A sharing change is still unconfirmed. Close this, then use Load latest."
					: "We could not confirm that you left. Check your connection, then try again.",
		);
	};

	return (
		<>
			<ul className="mt-3 flex flex-col">
				{KEYS.map((key) => {
					const mine = busy?.key === key;
					const checked = mine ? busy.value : data.choices[key];
					return (
						<li key={key} className="flex items-center gap-3 border-t border-line py-3 first:border-t-0">
							<div className="min-w-0 flex-1">
								<p className="font-medium text-ink">{RESIDENT_TEXT[key].label}</p>
								<p className="text-sm text-text-3">{RESIDENT_TEXT[key].description}</p>
							</div>
							{mine ? (
								<>
									<Spinner size={14} className="text-text-3" />
									<span className="sr-only" role="status">
										Saving
									</span>
								</>
							) : (
								<StatusBadge
									status={checked ? "positive" : "unknown"}
									size="sm"
									fill="soft"
									plain
									className="max-app-sm:hidden"
								>
									{checked ? "Shared" : "Not shared"}
								</StatusBadge>
							)}
							<Switch
								checked={checked}
								onCheckedChange={toggle(key)}
								disabled={busy !== null || save.held !== null || refreshing}
								aria-label={`Share ${RESIDENT_TEXT[key].label.toLowerCase()} with ${organizationName}`}
							/>
						</li>
					);
				})}
			</ul>
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
			<PrivateLine>{PRIVATE}</PrivateLine>
			<div className="mt-5 border-t border-line pt-4">
				<ConfirmDialog
					tone="danger"
					title={`Leave the residency at ${organizationName}?`}
					consequences={[
						`${organizationName} stops seeing your progress right away, also in saved reports.`,
						"Your reading, notes and documents stay yours.",
						`Records ${organizationName} keeps on its own, like your enrollment dates, stay with them.`,
						`This link cannot be used again. ${organizationName} can invite you again.`,
					]}
					confirmLabel="Leave residency"
					onConfirm={onLeave}
					trigger={
						<Button
							variant="ghost"
							size="sm"
							className="-ml-3"
							disabled={refreshing || busy !== null || save.held !== null}
						>
							Leave residency
						</Button>
					}
				/>
			</div>
		</>
	);
}
