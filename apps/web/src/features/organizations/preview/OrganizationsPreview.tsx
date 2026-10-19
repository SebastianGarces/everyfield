"use client";

import { Link01Icon, Notification01Icon, Unlink01Icon } from "@hugeicons/core-free-icons";
import { Card, PageHeader, SegmentedControl } from "@everyfield/ui/controls";
import { List, ListRow } from "@everyfield/ui/display";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Connections } from "../Connections";
import { InvitationResponse } from "../InvitationResponse";
import { formatDay, noticeText } from "../model";
import { PipelineAccessNote, PipelineTotals } from "../Pipeline";
import { ResidencyDisclosure, ResidencySharing } from "../Residency";
import {
	AGGREGATE,
	createBackend,
	FLOW_CONTROLS,
	INVITATION,
	nameOf,
	NAMES_FOR_PREVIEW,
	NOTICES,
	PLANT_TARGETS,
	readDisclosure,
	SCENARIO_LABEL,
	VIEWER_LABEL,
	VIEWERS,
	ZONE,
	type OrganizationFlow,
	type Scenario,
	type Viewer,
} from "./fixtures";

const STAGES = ["before", "after"] as const;
type Stage = (typeof STAGES)[number];

function pick<T extends string>(all: readonly T[], raw: string | null, fallback: T): T {
	return (all as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
}

const NOTE: Record<OrganizationFlow, string> = {
	connections:
		"A church's connections with sending churches and networks: connect, resend, withdraw, leave and history.",
	organization: "A network's connected churches. It can end its own connections and sees the pipeline totals state.",
	invitation:
		"The receiving organization answers one request from its emailed link. Nothing yet shows an expired or withdrawn link.",
	residency: "A resident chooses what to share before joining, then changes or leaves it.",
	pipeline: "A sending church opts in to pipeline totals for one network. It is off by default.",
	notices: "Coarse relationship notices. They name the organization and the event only.",
};

/**
 * The organization relationship previews at /design/organizations/[flow] (WP-007/ui). `as` picks the viewer,
 * `scenario` the sample state, and `stage=before` shows the residency choices before joining.
 */
export function OrganizationsPreview({ flow }: { flow: OrganizationFlow }) {
	const search = useSearchParams();
	const router = useRouter();
	const pathname = usePathname();
	const controls = FLOW_CONTROLS[flow];
	const viewer = controls.viewer ? pick(VIEWERS, search.get("as"), "owner") : "owner";
	const scenario = pick(controls.scenarios, search.get("scenario"), "connected");
	const stage = flow === "residency" ? pick(STAGES, search.get("stage"), "after") : "after";

	function set(key: string, value: string) {
		const next = new URLSearchParams(search);
		next.set(key, value);
		router.replace(`${pathname}?${next}`, { scroll: false });
	}

	return (
		<div className="min-h-dvh px-10 py-8 max-app-sm:px-4 max-app-sm:py-5">
			<div className="mx-auto flex max-w-[880px] flex-col gap-6">
				<aside
					aria-label="Preview controls"
					className="flex flex-col gap-3 rounded-lg border border-dashed border-line-2 p-4"
				>
					<p className="text-sm text-text-3">Design preview with sample data. {NOTE[flow]}</p>
					<div className="flex flex-wrap gap-x-6 gap-y-3">
						{controls.viewer ? (
							<SegmentedControl<Viewer>
								label="Preview as"
								size="sm"
								value={viewer}
								onValueChange={(v) => set("as", v)}
								options={VIEWERS.map((v) => ({ value: v, label: VIEWER_LABEL[v] }))}
							/>
						) : null}
						{flow === "residency" ? (
							<SegmentedControl<Stage>
								label="Step"
								size="sm"
								value={stage}
								onValueChange={(v) => set("stage", v)}
								options={[
									{ value: "before", label: "Before joining" },
									{ value: "after", label: "After joining" },
								]}
							/>
						) : null}
						{controls.scenarios.length > 0 ? (
							<SegmentedControl<Scenario>
								label="Scenario"
								size="sm"
								value={scenario}
								onValueChange={(v) => set("scenario", v)}
								options={controls.scenarios.map((s) => ({ value: s, label: SCENARIO_LABEL[s] }))}
							/>
						) : null}
					</div>
				</aside>
				<main id="main" className="flex flex-col gap-6">
					<Flow key={`${flow}-${viewer}-${scenario}`} flow={flow} viewer={viewer} scenario={scenario} stage={stage} />
				</main>
			</div>
		</div>
	);
}

function Flow({
	flow,
	viewer,
	scenario,
	stage,
}: {
	flow: OrganizationFlow;
	viewer: Viewer;
	scenario: Scenario;
	stage: string | null;
}) {
	const side = flow === "organization" ? "organization" : "subject";
	const backend = useMemo(() => createBackend(side, viewer, scenario), [side, viewer, scenario]);
	const canManage = viewer === "owner";

	switch (flow) {
		case "connections":
			return (
				<>
					<PageHeader
						breadcrumb={[{ label: "Settings", href: "#" }, { label: "Sharing and privacy" }]}
						title="Sharing and privacy"
					/>
					<Connections
						side="subject"
						load={backend.load}
						readMore={backend.read}
						canManage={canManage}
						nameOf={nameOf}
						zone={ZONE}
						run={backend.run}
						invite={{ targets: PLANT_TARGETS, readDisclosure, expectedRevision: "7" }}
						readSharing={backend.readSharing}
					/>
				</>
			);
		case "organization":
			return (
				<>
					<PageHeader
						breadcrumb={[{ label: "Network", href: "#" }, { label: "Connections" }]}
						title={NAMES_FOR_PREVIEW.network}
					/>
					<Connections
						side="organization"
						load={backend.load}
						readMore={backend.read}
						canManage={canManage}
						nameOf={nameOf}
						zone={ZONE}
						run={backend.run}
					/>
					<PipelineAccessNote access={scenario === "connected" ? AGGREGATE.allowed : AGGREGATE.withheld} />
				</>
			);
		case "invitation":
			return (
				<div className="py-6">
					<InvitationResponse
						invitation={scenario === "none" ? null : INVITATION}
						proof="sample-original-address-proof"
						nameOf={nameOf}
						zone={ZONE}
						run={backend.run}
						connectionsHref="/design/organizations/organization"
					/>
				</div>
			);
		case "residency":
			return stage === "before" ? (
				<BeforeJoining />
			) : (
				<>
					<PageHeader title="My residency" />
					<ResidencySharing
						linkId={backend.residencyLink}
						read={backend.readResidency}
						organizationName={NAMES_FOR_PREVIEW.network}
						run={backend.run}
					/>
				</>
			);
		case "pipeline":
			return (
				<>
					<PageHeader
						breadcrumb={[{ label: "Settings", href: "#" }, { label: "Sharing and privacy" }]}
						title={NAMES_FOR_PREVIEW.church}
					/>
					<PipelineTotals
						relationshipId="00000021-1b3d-4f5a-8c7e-9d0f1a2b3c4d"
						networkName={NAMES_FOR_PREVIEW.network}
						canManage={canManage}
						run={backend.run}
					/>
				</>
			);
		case "notices":
			return (
				<>
					<PageHeader title="Notifications" />
					<Card>
						<List aria-label="Relationship notices">
							{NOTICES.map((n) => (
								<ListRow
									key={n.kind}
									icon={
										n.kind === "relationship_approved"
											? Link01Icon
											: n.kind === "relationship_ended"
												? Unlink01Icon
												: Notification01Icon
									}
									tone={n.kind === "relationship_approved" ? "green" : "ink"}
									title={noticeText(n.kind, n.organization)}
									subtitle={formatDay(n.at, ZONE)}
								/>
							))}
						</List>
					</Card>
				</>
			);
	}
}

function BeforeJoining() {
	const [joined, setJoined] = useState<string | null>(null);
	return (
		<div className="flex flex-col gap-4 py-6">
			<ResidencyDisclosure
				organizationName={NAMES_FOR_PREVIEW.network}
				onAccept={async (choices) => {
					await new Promise((r) => setTimeout(r, 450));
					const shared = [
						choices.shareFoundations && "foundation progress",
						choices.shareMilestones && "milestone progress",
					].filter(Boolean);
					setJoined(shared.length ? `Joined. Sharing ${shared.join(" and ")}.` : "Joined. Nothing is shared.");
				}}
			/>
			<p role="status" className="text-center text-sm text-text-2 empty:hidden">
				{joined}
			</p>
		</div>
	);
}
