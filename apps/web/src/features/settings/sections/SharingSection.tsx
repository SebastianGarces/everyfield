"use client";

import { HierarchyIcon, LockKeyIcon } from "@hugeicons/core-free-icons";
import { CardIcon, Skeleton, Spinner, Switch, Card, Button } from "@everyfield/ui/controls";
import { LoadableView, StatusBadge } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { useState } from "react";
import type { AffiliationPatch, PlantOwner, Relationship, SectionResult } from "../port";
import { newRequestKey } from "../port";
import { refusalOf, type Refusal } from "../save";
import { AutoSaveFooter, SaveError, SectionBody } from "../SettingsDialog";
import { useSection, useSettings } from "../store";

type Affiliation = Extract<SectionResult, { section: "affiliations" }>;
type Choices = Extract<Affiliation["values"], { view: "plant_administration" }>["choices"];
type Category = keyof Choices;

// REQ-IDN-022 categories in the settings patch's words: teams is ministry_teams and activityPush is activity.
const PATCH_FIELD: Record<Category, keyof AffiliationPatch> = {
	people: "people",
	meetings: "meetings",
	tasks: "tasks",
	ministry_teams: "teams",
	wiki: "wiki",
	activity: "activityPush",
	shared_findings: "shared_findings",
};

const CATEGORY_TEXT: Record<Category, { label: string; description: string }> = {
	people: { label: "People", description: "Counts only, never names or personal details" },
	meetings: { label: "Meetings", description: "Counts and attendance totals" },
	tasks: { label: "Tasks", description: "Counts and progress" },
	ministry_teams: { label: "Ministry teams", description: "Teams and how many serve" },
	wiki: { label: "Wiki", description: "Totals for articles your church writes" },
	activity: { label: "Activity updates", description: "Milestones sent to them as they happen" },
	shared_findings: { label: "Plant Intelligence findings", description: "Shown to you first, then shared" },
};

export function SharingSection({ relationships }: { relationships: Relationship[] }) {
	const { viewer } = useSettings();
	if (viewer.context !== "plant") return null;
	return (
		<>
			<SectionBody>
				{relationships.length === 0 ? (
					<p className="py-6 text-text-2">
						Your church is not connected to a sending church or network. Nothing is shared.
					</p>
				) : (
					<div className="mt-4 flex flex-col gap-4">
						{relationships.map((r) => (
							<AffiliationCard key={r.relationshipId} plant={viewer.plant} relationship={r} />
						))}
					</div>
				)}
				<p className="mt-6 flex items-center gap-2 text-sm text-text-3">
					<Icon icon={LockKeyIcon} size={16} />
					Private check-ins, notes about care and personal details are never shared.
				</p>
			</SectionBody>
			<AutoSaveFooter />
		</>
	);
}

function AffiliationCard({ plant, relationship }: { plant: PlantOwner; relationship: Relationship }) {
	const { state, replace, reload } = useSection({
		section: "affiliations",
		plant,
		organization: relationship.organization,
	});
	return (
		<Card size="sm" as="section" aria-label={relationship.organizationName}>
			<div className="flex items-center gap-3">
				<CardIcon icon={HierarchyIcon} tone="blue" size={36} />
				<div className="min-w-0 flex-1">
					<h3 className="font-semibold text-ink">{relationship.organizationName}</h3>
					<p className="text-sm text-text-3">
						{relationship.organization.organizationKind === "sending_network" ? "Sending network" : "Sending church"}
					</p>
				</div>
			</div>
			<LoadableView
				state={state}
				empty={{ title: "" }}
				loadingLabel={`Loading what ${relationship.organizationName} can see`}
				skeleton={
					<div className="mt-4 flex flex-col gap-3">
						{[0, 1, 2].map((i) => (
							<Skeleton key={i} shape="line" height={28} />
						))}
					</div>
				}
			>
				{(section) => <Choices section={section} relationship={relationship} replace={replace} reload={reload} />}
			</LoadableView>
		</Card>
	);
}

/**
 * The affiliation switches (REQ-IDN-010). Each switch sends a closed patch of that one category with the current
 * relationship and consent revisions; omitted categories keep their stored value. Members see the choices are set
 * by Owners and Admins. A refusal puts the switch back and says why.
 */
function Choices({
	section,
	relationship,
	replace,
	reload,
}: {
	section: Affiliation;
	relationship: Relationship;
	replace: (value: SectionResult) => void;
	reload: () => void;
}) {
	const { port } = useSettings();
	const [pending, setPending] = useState<{ category: Category; value: boolean } | null>(null);
	const [refusal, setRefusal] = useState<Refusal | null>(null);
	const values = section.values;

	if ("status" in values || values.view === "organization") {
		return <p className="mt-4 text-text-2">This connection is not available to change here.</p>;
	}
	if (!values.activeAffiliation) {
		return <p className="mt-4 text-text-2">This connection has ended. Nothing is shared with it.</p>;
	}
	if (values.view === "plant_member") {
		return (
			<p className="mt-4 text-text-2">
				Owners and Admins choose what {values.organizationDisplayName} can see. Personal details are never shared.
			</p>
		);
	}

	const admin = values;
	const toggle = (category: Category) => async (value: boolean) => {
		if (pending) return;
		setPending({ category, value });
		setRefusal(null);
		try {
			const reply = await port.saveSection({
				requestKey: newRequestKey("sharing"),
				expectedRevision: relationship.revision,
				input: {
					section: "affiliations",
					plant: admin.plant,
					organization: admin.organization,
					relationshipId: relationship.relationshipId,
					expectedConsentRevision: admin.consentRevision,
					patch: { [PATCH_FIELD[category]]: value },
				},
			});
			if (reply.status === "ok") replace(reply.value.current);
			else setRefusal(refusalOf(reply.error));
		} catch {
			setRefusal({ message: "Your change was not saved. Try again.", reference: "EF-OFFLINE", code: "temporary" });
		} finally {
			setPending(null);
		}
	};

	return (
		<>
			<div aria-live="polite" className="mt-3 empty:hidden">
				{refusal ? (
					<SaveError
						message={refusal.message}
						reference={refusal.reference}
						action={
							refusal.code === "conflict" ? (
								<Button size="sm" variant="secondary" onClick={reload}>
									Load latest
								</Button>
							) : undefined
						}
					/>
				) : null}
			</div>
			<ul className="mt-2 flex flex-col">
				{(Object.keys(CATEGORY_TEXT) as Category[]).map((category) => {
					const busy = pending?.category === category;
					const checked = busy ? pending.value : admin.choices[category];
					return (
						<li key={category} className="flex items-center gap-3 border-t border-line py-3 first:border-t-0">
							<div className="min-w-0 flex-1">
								<p className="font-medium text-ink">{CATEGORY_TEXT[category].label}</p>
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
								disabled={pending !== null && !busy}
								aria-label={`Share ${CATEGORY_TEXT[category].label} with ${admin.organizationDisplayName}`}
							/>
						</li>
					);
				})}
			</ul>
		</>
	);
}
