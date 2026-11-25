"use client";

import {
	setDiscoverySharingRequest,
	type discoverySharing,
	type sharedFoundations,
} from "@everyfield/contracts/organizations";
import { Spinner, Switch } from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { useState } from "react";
import type { z } from "zod";
import foundations from "../../../../../docs/reference/discovery-foundations.json" with { type: "json" };
import { useIntent } from "../../components/intent.ts";
import { ProblemLine } from "./parts";

export type DiscoveryRow = z.infer<typeof discoverySharing>;
export type SharedFoundations = z.infer<typeof sharedFoundations>;
export type SaveDiscoverySharing = (
	command: ReturnType<typeof setDiscoverySharingRequest.parse>,
) => Promise<DiscoveryRow | null>;

const ARTICLES = [...foundations.articles].sort((a, b) => a.sort_order - b.sort_order);

export function FoundationsSwitch({
	row,
	organizationName,
	save,
	onSaved,
}: {
	row: DiscoveryRow;
	organizationName: string;
	save: SaveDiscoverySharing;
	onSaved: (row: DiscoveryRow) => void;
}) {
	const intent = useIntent<object>("discovery-sharing");
	const [busy, setBusy] = useState<boolean | null>(null);
	const checked = busy ?? row.shareFoundations;
	const toggle = async (value: boolean) => {
		if (busy !== null || intent.held) return;
		setBusy(value);
		const result = await intent.run(
			"foundations",
			(requestKey) =>
				setDiscoverySharingRequest.parse({
					requestKey,
					expectedRevision: row.revision,
					input: {
						relationshipId: row.relationshipId,
						expectedConsentRevision: row.consentRevision,
						shareFoundations: value,
					},
				}),
			save,
			(saved) => saved !== null,
		);
		setBusy(null);
		if (result.ok && result.reply) onSaved(result.reply);
	};
	return (
		<div className="mt-2 rounded-md border border-line px-3 py-2.5">
			<div className="flex items-center gap-3">
				<div className="min-w-0 flex-1">
					<p className="font-medium text-ink">Foundations reading</p>
					<p className="text-sm text-text-3">
						{checked
							? `${organizationName} sees which of the six foundations you've completed.`
							: `${organizationName} sees only your name and when you connected.`}
					</p>
				</div>
				{busy !== null ? (
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
					onCheckedChange={(value) => void toggle(value)}
					disabled={busy !== null || intent.held !== null}
					aria-label={`Share your foundations reading with ${organizationName}`}
				/>
			</div>
			<ProblemLine
				problem={intent.problem}
				refused="Your choice was not saved. It changed somewhere else. Reload the page and try again."
			/>
			<p className="mt-1.5 text-xs text-text-3">
				They never see your documents, notes or Evry chats, and this connection shares no milestones.
			</p>
		</div>
	);
}

export function FoundationsView({ shared }: { shared: SharedFoundations | undefined }) {
	if (!shared) return <p className="mt-1 text-sm text-text-3">Their foundations reading isn't shared with you.</p>;
	const done = new Set<string>(shared.completed);
	return (
		<div className="mt-2">
			<p className="text-sm text-text-2">
				Foundations: {done.size} of {shared.total} completed
			</p>
			<ul className="mt-1 flex flex-col gap-0.5 text-sm">
				{ARTICLES.map((a) => (
					<li key={a.id} className={done.has(a.id) ? "text-ink" : "text-text-3"}>
						{done.has(a.id) ? "Completed: " : "Not yet: "}
						{a.title}
					</li>
				))}
			</ul>
		</div>
	);
}
