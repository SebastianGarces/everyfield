"use client";

import { readSharingRequest, setSharingRequest, type sharingResult } from "@everyfield/contracts/organizations";
import { Button, Skeleton, Spinner, Switch } from "@everyfield/ui/controls";
import { LoadableView, StatusBadge } from "@everyfield/ui/display";
import { useCallback, useState } from "react";
import type { z } from "zod";
import { NotAvailable } from "../access/AccessStates";
import { useIntent, useLoad } from "../../components/intent.ts";
import { CATEGORIES, CATEGORY_TEXT } from "./model";
import { ProblemLine } from "./parts";
import type { Category, Relationship } from "./port";

type Sharing = z.infer<typeof sharingResult>;
type Admin = Extract<Sharing, { view: "plant_administration" }>;
type SetCommand = ReturnType<typeof setSharingRequest.parse>;

const REFUSED: Record<string, string> = {
	stale_revision: "Your choice was not saved. It changed somewhere else. Load the latest and try again.",
};

export type SharingRow = { sharing: Sharing; relationshipRevision: string };
export type ReadSharing = (
	relationshipId: string,
	request: ReturnType<typeof readSharingRequest.parse>,
) => Promise<SharingRow>;
export type SaveSharing = (command: SetCommand) => Promise<SharingRow | null>;

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
	initial?: SharingRow;
	read: ReadSharing;
	save: SaveSharing;
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
	refreshing: boolean;
	onSaved: (row: SharingRow) => void;
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
