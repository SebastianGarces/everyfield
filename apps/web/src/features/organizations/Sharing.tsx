"use client";

import { readSharingRequest, setSharingRequest, type sharingResult } from "@everyfield/contracts/organizations";
import { Button, Skeleton, Spinner, Switch } from "@everyfield/ui/controls";
import { LoadableView, StatusBadge } from "@everyfield/ui/display";
import { useCallback, useState } from "react";
import type { z } from "zod";
import { NotAvailable } from "../access/AccessStates";
import { useIntent, useLoad } from "./intent";
import { CATEGORIES, CATEGORY_TEXT } from "./model";
import { ProblemLine } from "./parts";
import type { Category, Relationship } from "./port";

type Sharing = z.infer<typeof sharingResult>;
type Admin = Extract<Sharing, { view: "plant_administration" }>;
type SetCommand = ReturnType<typeof setSharingRequest.parse>;

const REFUSED: Record<string, string> = {
	stale_revision: "Your choice was not saved. It changed somewhere else. Load the latest and try again.",
};

/**
 * The organization's view of this connection and the connection revision a change must carry. privacy.getSharing
 * returns only the consent revision, so the caller supplies the connection revision (ruling D17).
 */
export type SharingRow = { sharing: Sharing; relationshipRevision: string };
export type ReadSharing = (
	relationshipId: string,
	request: ReturnType<typeof readSharingRequest.parse>,
) => Promise<SharingRow>;
/** Saves one choice. The answer is the connection's sharing as saved now, or null when nothing was saved. */
export type SaveSharing = (command: SetCommand) => Promise<SharingRow | null>;

/**
 * What one connected organization can see (REQ-IDN-022), on the plant's own connection row. Owners and Admins turn
 * each category on or off for this exact organization; Members see that Owners and Admins choose. The words match
 * the settings sharing card (WP-010/ui). The list reads the card's state with the page; each save answers with the
 * state as saved, so the next change carries the current connection and consent revisions without another read.
 */
export function SharingChoices({
	relationship,
	organizationName,
	initial,
	read,
	save,
	onChanged,
}: {
	relationship: Relationship;
	organizationName: string;
	/** The state as the list read it with the page; the card reads again only after a save. */
	initial?: SharingRow;
	read: ReadSharing;
	save: SaveSharing;
	/** After a save: the connection's revision moved, so the list that owns Leave takes the new one. */
	onChanged: (relationshipRevision: string) => void;
}) {
	const pair = relationship.pair;
	const fetch = useCallback(
		() =>
			pair.kind === "plant"
				? read(relationship.id, readSharingRequest.parse({ plant: pair.subject, organization: pair.organization }))
				: Promise.resolve({ sharing: { status: "unavailable" } as Sharing, relationshipRevision: "0" }),
		[pair, read, relationship.id],
	);
	const { state, reload, update, refreshing } = useLoad(
		fetch,
		`What ${organizationName} can see did not load`,
		initial,
	);
	return (
		<LoadableView
			state={state}
			empty={{ title: "" }}
			loadingLabel={`Loading what ${organizationName} can see`}
			skeleton={
				<div className="mt-3 flex flex-col gap-2">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} shape="line" height={24} />
					))}
				</div>
			}
		>
			{({ sharing: data, relationshipRevision }) =>
				"status" in data || data.view === "organization" ? (
					<NotAvailable scope="section" />
				) : data.view === "plant_member" ? (
					<p className="mt-2 text-sm text-text-3">
						Owners and Admins choose what {data.organizationDisplayName} can see. Personal details are never shared.
					</p>
				) : (
					<Switches
						key={`${relationshipRevision}/${data.consentRevision}`}
						data={data}
						relationshipId={relationship.id}
						relationshipRevision={relationshipRevision}
						save={save}
						refreshing={refreshing}
						onSaved={(row) => {
							update(() => row);
							onChanged(row.relationshipRevision);
						}}
						onStale={reload}
					/>
				)
			}
		</LoadableView>
	);
}

function Switches({
	data,
	relationshipId,
	relationshipRevision,
	save: send,
	refreshing,
	onSaved,
	onStale,
}: {
	data: Admin;
	relationshipId: string;
	relationshipRevision: string;
	save: SaveSharing;
	/** A fresh read is running: the revisions on screen may be old, so nothing is sent until it arrives. */
	refreshing: boolean;
	onSaved: (row: SharingRow) => void;
	/** Read the latest state, after an unconfirmed change. */
	onStale: () => void;
}) {
	const save = useIntent<SetCommand>("privacy-sharing");
	const [next, setNext] = useState<{ category: Category; value: boolean } | null>(null);

	const toggle = (category: Category) => async (value: boolean) => {
		if (save.held || save.pending || next || refreshing) return;
		setNext({ category, value });
		const result = await save.run(
			category,
			(requestKey) =>
				setSharingRequest.parse({
					requestKey,
					expectedRevision: relationshipRevision,
					input: {
						plant: data.plant,
						organization: data.organization,
						relationshipId,
						expectedConsentRevision: data.consentRevision,
						category,
						enabled: value,
					},
				}),
			send,
			(row) => row !== null,
		);
		// On success the switches re-mount on the new revisions; until then they keep the saved value and stay disabled.
		if (result.ok && result.reply) onSaved(result.reply);
		else setNext(null);
	};

	return (
		<>
			<ul className="mt-2 flex flex-col" aria-label={`What ${data.organizationDisplayName} can see`}>
				{CATEGORIES.map((category) => {
					const busy = next?.category === category;
					const checked = busy ? next.value : data.choices[category];
					return (
						<li key={category} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
							<div className="min-w-0 flex-1">
								<p className="text-sm font-medium text-ink">{CATEGORY_TEXT[category].label}</p>
								<p className="text-sm text-text-3">{CATEGORY_TEXT[category].description}</p>
							</div>
							{busy ? (
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
								onCheckedChange={toggle(category)}
								disabled={next !== null || save.held !== null || refreshing}
								aria-label={`Share ${CATEGORY_TEXT[category].label} with ${data.organizationDisplayName}`}
							/>
						</li>
					);
				})}
			</ul>
			<ProblemLine
				problem={save.problem}
				refused={REFUSED[save.code ?? ""] ?? "Your choice was not saved. Nothing changed."}
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
		</>
	);
}
