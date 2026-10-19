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
import type { Category, Relationship, Run } from "./port";

type Sharing = z.infer<typeof sharingResult>;
type Admin = Extract<Sharing, { view: "plant_administration" }>;
type SetCommand = ReturnType<typeof setSharingRequest.parse>;

const REFUSED: Record<string, string> = {
	stale_revision: "Your choice was not saved. It changed somewhere else. Load the latest and try again.",
};

/**
 * What one connected organization can see (REQ-IDN-022), on the plant's own connection row. Owners and Admins turn
 * each category on or off for this exact organization; Members see that Owners and Admins choose. The words match
 * the settings sharing card (WP-010/ui). Every save sends this connection's current revision and consent revision,
 * then the list reloads, so the next switch always carries fresh revisions.
 */
export function SharingChoices({
	relationship,
	organizationName,
	run,
	onSaved,
}: {
	relationship: Relationship;
	organizationName: string;
	run: Run;
	/** Reload the connection list, which brings the new revisions. */
	onSaved: () => void;
}) {
	const pair = relationship.pair;
	const fetch = useCallback(
		() =>
			pair.kind === "plant"
				? run("privacy.getSharing", readSharingRequest.parse({ plant: pair.subject, organization: pair.organization }))
				: Promise.resolve({ status: "unavailable" } as Sharing),
		[pair, run],
	);
	const { state } = useLoad<Sharing>(fetch, `What ${organizationName} can see did not load`);
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
			{(data) =>
				"status" in data || data.view === "organization" ? (
					<NotAvailable scope="section" />
				) : data.view === "plant_member" ? (
					<p className="mt-2 text-sm text-text-3">
						Owners and Admins choose what {data.organizationDisplayName} can see. Personal details are never shared.
					</p>
				) : (
					<Switches data={data} relationship={relationship} run={run} onSaved={onSaved} />
				)
			}
		</LoadableView>
	);
}

function Switches({
	data,
	relationship,
	run,
	onSaved,
}: {
	data: Admin;
	relationship: Relationship;
	run: Run;
	onSaved: () => void;
}) {
	const save = useIntent<SetCommand>("privacy-sharing");
	const [next, setNext] = useState<{ category: Category; value: boolean } | null>(null);

	const toggle = (category: Category) => async (value: boolean) => {
		if (save.held || save.pending) return;
		setNext({ category, value });
		const result = await save.run(
			category,
			(requestKey) =>
				setSharingRequest.parse({
					requestKey,
					expectedRevision: relationship.revision,
					input: {
						plant: data.plant,
						organization: data.organization,
						relationshipId: relationship.id,
						expectedConsentRevision: data.consentRevision,
						category,
						enabled: value,
					},
				}),
			(command) => run("privacy.setSharing", command),
			(r) => r.status === "committed",
		);
		setNext(null);
		if (result.ok) onSaved();
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
								disabled={(save.pending !== null && !busy) || save.held !== null}
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
							onSaved();
						}}
					>
						Load latest
					</Button>
				}
			/>
		</>
	);
}
