"use client";

import { normalizedEmail } from "@everyfield/contracts/identity";
import {
	GATHERING_DESCRIPTION_MAX,
	GATHERING_NAME_MAX,
	STATEMENT_OF_FAITH_MAX,
} from "@everyfield/contracts/organizations";
import { Button, Checkbox, Field, Input, Skeleton, StatePanel, Textarea } from "@everyfield/ui/controls";
import { LoadableView } from "@everyfield/ui/display";
import { useState } from "react";
import type { OrganizationOwner, SectionResult } from "../port";
import { attempt } from "../save";
import { SaveError, SaveFooter, SectionBody, SettingRow } from "../SettingsDialog";
import { useDraft, useSection, useSettings } from "../store";
import { zoneLabel } from "../time";

type Organization = Extract<SectionResult, { section: "organization" }>;
type Available = Extract<Organization["values"], { status: "available" }>;
const FIELDS = [
	"name",
	"city",
	"stateProvince",
	"country",
	"description",
	"contactEmail",
	"contactPhone",
	"statementOfFaith",
] as const;
/** The milestone offered to the organization's plants (T-296) is edited as three form fields and saved as one value. */
type Form = Record<(typeof FIELDS)[number] | "gatheringName" | "gatheringDescription", string> & {
	gatheringOffered: boolean;
};
type TextField = Exclude<keyof Form, "gatheringOffered">;
const LIMIT: Record<TextField, number> = {
	name: 200,
	city: 200,
	stateProvince: 200,
	country: 200,
	description: 5000,
	contactEmail: 320,
	contactPhone: 50,
	statementOfFaith: STATEMENT_OF_FAITH_MAX,
	gatheringName: GATHERING_NAME_MAX,
	gatheringDescription: GATHERING_DESCRIPTION_MAX,
};
const GATHERING = ["gatheringOffered", "gatheringName", "gatheringDescription"] as const;

function formOf(values: Available): Form {
	const g = values.profile.gatheringMilestone;
	return {
		...(Object.fromEntries(FIELDS.map((k) => [k, values.profile[k] ?? ""])) as Record<(typeof FIELDS)[number], string>),
		gatheringOffered: g.offered,
		gatheringName: g.name ?? "",
		gatheringDescription: g.description ?? "",
	};
}

function validateOrganization(form: Form): Partial<Record<keyof Form, string>> {
	const errors: Partial<Record<keyof Form, string>> = {};
	if (!form.name.trim()) errors.name = "Enter the organization's name.";
	if (form.gatheringOffered && !form.gatheringName.trim())
		errors.gatheringName = "Name the milestone your plants reach.";
	for (const k of [...FIELDS, "gatheringName", "gatheringDescription"] as const)
		if (form[k].trim().length > LIMIT[k]) errors[k] = `Use ${LIMIT[k].toLocaleString("en-US")} characters or fewer.`;
	if (form.contactEmail.trim() && !normalizedEmail.safeParse(form.contactEmail).success)
		errors.contactEmail = "Enter a full email address, like office@church.org.";
	return errors;
}

/**
 * The organization profile for a sending church or network (REQ-IDN-026): its own Owner or Admin edits name,
 * locality, description and contact. A network also writes its statement of faith, which fills the doctrinal section
 * of Church Documents its churches create from a template (DOC-020, D-107). The kind and identity are not editable here, and nothing here transfers or
 * deletes the organization.
 */
export function OrganizationSection() {
	const { viewer } = useSettings();
	if (viewer.context !== "organization") return null;
	return <OrganizationLoaded organization={viewer.organization} admin={viewer.role !== "member"} />;
}

function OrganizationLoaded({ organization, admin }: { organization: OrganizationOwner; admin: boolean }) {
	const { state, replace, reload } = useSection(
		{ section: "organization", organization },
		{
			key: "organization",
			formOf: (section) => (section.values.status === "available" ? formOf(section.values) : undefined),
		},
	);
	return (
		<LoadableView
			state={state}
			empty={{ title: "" }}
			loadingLabel="Loading organization profile"
			skeleton={
				<SectionBody>
					<div className="flex flex-col gap-6 pt-4">
						{[0, 1, 2].map((i) => (
							<Skeleton key={i} shape="block" height={44} />
						))}
					</div>
				</SectionBody>
			}
		>
			{(section) =>
				section.values.status === "available" ? (
					admin ? (
						<OrganizationForm values={section.values} replace={replace} reload={reload} />
					) : (
						<OrganizationView values={section.values} />
					)
				) : (
					<SectionBody>
						<StatePanel tone="lock" title="This profile is not available" headingLevel="h3">
							Only an Owner or Admin of this organization can change its profile.
						</StatePanel>
					</SectionBody>
				)
			}
		</LoadableView>
	);
}

function OrganizationForm({
	values,
	replace,
	reload,
}: {
	values: Available;
	replace: (value: SectionResult) => void;
	reload: () => void;
}) {
	const { port } = useSettings();
	const saved = formOf(values);
	const { draft, setDraft, dirty, saving, refusal, save: runSave } = useDraft<Form>("organization", saved);
	const [checked, setChecked] = useState(false);
	const errors = validateOrganization(draft);
	const visible = checked ? errors : {};
	const set = (k: TextField) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });

	const save = () => {
		setChecked(true);
		if (Object.keys(errors).length > 0) return;
		void runSave(async (sent) => {
			const patch: Record<string, unknown> = Object.fromEntries(
				FIELDS.filter((k) => sent[k].trim() !== saved[k]).map((k) => [
					k,
					k === "name" ? sent.name.trim() : sent[k].trim() === "" ? null : sent[k].trim(),
				]),
			);
			if (GATHERING.some((k) => (typeof sent[k] === "string" ? String(sent[k]).trim() : sent[k]) !== saved[k]))
				patch.gatheringMilestone = {
					offered: sent.gatheringOffered,
					name: sent.gatheringName.trim() || null,
					description: sent.gatheringDescription.trim() || null,
				};
			if (Object.keys(patch).length === 0) return { ok: true, server: formOf(values) };
			const input = { section: "organization" as const, organization: values.organization, patch };
			const result = await attempt("organization-profile", (requestKey) =>
				port.saveSection({ requestKey, expectedRevision: values.revision, input }),
			);
			if (!result.ok) return { ok: false, refusal: result.refusal };
			const current = result.value.current;
			replace(current);
			const now =
				current.section === "organization" && current.values.status === "available" ? formOf(current.values) : saved;
			return { ok: true, server: now };
		});
	};

	return (
		<>
			<SectionBody>
				<SettingRow label="Name" description="Shown to the churches you work with.">
					<Field label={<span className="sr-only">Organization name</span>} error={visible.name}>
						<Input
							value={draft.name}
							onChange={set("name")}
							autoComplete="organization"
							invalid={Boolean(visible.name)}
						/>
					</Field>
				</SettingRow>
				<SettingRow label="Kind" description="Set when the organization was created.">
					<span className="font-medium text-ink">
						{values.organization.organizationKind === "sending_network" ? "Sending network" : "Sending church"}
					</span>
				</SettingRow>
				<SettingRow label="Location" description="All optional.">
					<div className="grid grid-cols-3 gap-3 max-app-sm:grid-cols-1">
						<Field label="City" error={visible.city}>
							<Input value={draft.city} onChange={set("city")} autoComplete="address-level2" />
						</Field>
						<Field label="State or province" error={visible.stateProvince}>
							<Input value={draft.stateProvince} onChange={set("stateProvince")} autoComplete="address-level1" />
						</Field>
						<Field label="Country" error={visible.country}>
							<Input value={draft.country} onChange={set("country")} autoComplete="country-name" />
						</Field>
					</div>
				</SettingRow>
				<SettingRow label="About" description="Optional.">
					<Field label={<span className="sr-only">About the organization</span>} error={visible.description}>
						<Textarea value={draft.description} onChange={set("description")} invalid={Boolean(visible.description)} />
					</Field>
				</SettingRow>
				<SettingRow label="Contact" description="Optional. Churches use this to reach you.">
					<div className="grid grid-cols-2 gap-3 max-app-sm:grid-cols-1">
						<Field label="Email" error={visible.contactEmail}>
							<Input
								type="email"
								value={draft.contactEmail}
								onChange={set("contactEmail")}
								autoComplete="email"
								invalid={Boolean(visible.contactEmail)}
							/>
						</Field>
						<Field label="Phone" error={visible.contactPhone}>
							<Input type="tel" value={draft.contactPhone} onChange={set("contactPhone")} autoComplete="tel" />
						</Field>
					</div>
				</SettingRow>
				{values.organization.organizationKind === "sending_network" ? (
					<SettingRow
						label="Statement of faith"
						description="Optional. It fills the doctrinal section of new documents your churches create."
					>
						<Field label={<span className="sr-only">Statement of faith</span>} error={visible.statementOfFaith}>
							<Textarea
								value={draft.statementOfFaith}
								onChange={set("statementOfFaith")}
								rows={8}
								invalid={Boolean(visible.statementOfFaith)}
							/>
						</Field>
					</SettingRow>
				) : null}
				<SettingRow
					label="Gathering milestone"
					description="Optional. For plants that never hold a Launch Sunday, such as house churches. Each plant's Owner or Admin chooses whether to use it."
				>
					<div className="flex flex-col gap-3">
						<Checkbox
							label="Our plants may end the gathering phase with a milestone instead of Launch Sunday"
							checked={draft.gatheringOffered}
							onCheckedChange={(checked) => setDraft({ ...draft, gatheringOffered: checked === true })}
						/>
						<Field
							label="Milestone name"
							hint={`Required to offer it. Up to ${GATHERING_NAME_MAX} characters, for example Constituted as a church.`}
							error={visible.gatheringName}
						>
							<Input
								value={draft.gatheringName}
								onChange={set("gatheringName")}
								invalid={Boolean(visible.gatheringName)}
							/>
						</Field>
						<Field
							label="What it means (optional)"
							hint={`Up to ${GATHERING_DESCRIPTION_MAX.toLocaleString("en-US")} characters. Your plants see it on their Launch plan.`}
							error={visible.gatheringDescription}
						>
							<Textarea
								value={draft.gatheringDescription}
								onChange={set("gatheringDescription")}
								rows={4}
								invalid={Boolean(visible.gatheringDescription)}
							/>
						</Field>
					</div>
				</SettingRow>
				<SettingRow label="Time zone">
					<span className="font-medium text-ink">{zoneLabel(values.timeZone)}</span>
				</SettingRow>
			</SectionBody>
			<SaveFooter
				section="organization"
				dirty={dirty}
				saving={saving}
				onSave={save}
				error={
					refusal ? (
						<SaveError
							message={refusal.message}
							reference={refusal.reference}
							action={
								refusal.code === "conflict" || refusal.code === "unknown" ? (
									<Button size="sm" variant="secondary" onClick={reload}>
										Load latest
									</Button>
								) : undefined
							}
						/>
					) : checked && Object.keys(errors).length > 0 ? (
						<SaveError message="Some values need a change before you can save. They are marked in red." />
					) : undefined
				}
			/>
		</>
	);
}

/** An organization Member reads the profile and the milestone offered to its plants, with nothing to change. */
function OrganizationView({ values }: { values: Available }) {
	const p = values.profile;
	const g = p.gatheringMilestone;
	return (
		<SectionBody>
			<p className="pt-4 text-sm text-text-2">Only an Owner or Admin of this organization can change its profile.</p>
			<SettingRow label="Name">
				<span className="font-medium text-ink">{p.name}</span>
			</SettingRow>
			<SettingRow
				label="Gathering milestone"
				description="What this organization's plants may reach instead of Launch Sunday."
			>
				{g.offered && g.name ? (
					<div className="flex flex-col gap-1">
						<span className="font-medium text-ink">{g.name}</span>
						{g.description ? <p className="text-sm whitespace-pre-line text-text-2">{g.description}</p> : null}
					</div>
				) : (
					<span className="text-text-2">Not offered. Plants end the gathering phase with Launch Sunday.</span>
				)}
			</SettingRow>
		</SectionBody>
	);
}
