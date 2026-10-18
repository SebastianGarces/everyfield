"use client";

import { normalizedEmail } from "@everyfield/contracts/identity";
import { Button, Field, Input, Skeleton, StatePanel, Textarea } from "@everyfield/ui/controls";
import { LoadableView } from "@everyfield/ui/display";
import { useState } from "react";
import type { OrganizationOwner, SectionResult } from "../port";
import { attempt } from "../save";
import { SaveError, SaveFooter, SectionBody, SettingRow } from "../SettingsDialog";
import { useDraft, useSection, useSettings } from "../store";
import { zoneLabel } from "../time";

type Organization = Extract<SectionResult, { section: "organization" }>;
type Available = Extract<Organization["values"], { status: "available" }>;
type Form = Record<
	"name" | "city" | "stateProvince" | "country" | "description" | "contactEmail" | "contactPhone",
	string
>;
const FIELDS = ["name", "city", "stateProvince", "country", "description", "contactEmail", "contactPhone"] as const;
const LIMIT: Record<keyof Form, number> = {
	name: 200,
	city: 200,
	stateProvince: 200,
	country: 200,
	description: 5000,
	contactEmail: 320,
	contactPhone: 50,
};

function formOf(values: Available): Form {
	return Object.fromEntries(FIELDS.map((k) => [k, values.profile[k] ?? ""])) as Form;
}

export function validateOrganization(form: Form): Partial<Record<keyof Form, string>> {
	const errors: Partial<Record<keyof Form, string>> = {};
	if (!form.name.trim()) errors.name = "Enter the organization's name.";
	for (const k of FIELDS)
		if (form[k].trim().length > LIMIT[k]) errors[k] = `Use ${LIMIT[k].toLocaleString("en-US")} characters or fewer.`;
	if (form.contactEmail.trim() && !normalizedEmail.safeParse(form.contactEmail).success)
		errors.contactEmail = "Enter a full email address, like office@church.org.";
	return errors;
}

/**
 * The organization profile for a sending church or network (REQ-IDN-026): its own Owner or Admin edits name,
 * locality, description and contact. The kind and identity are not editable here, and nothing here transfers or
 * deletes the organization.
 */
export function OrganizationSection() {
	const { viewer } = useSettings();
	if (viewer.context !== "organization") return null;
	return <OrganizationLoaded organization={viewer.organization} />;
}

function OrganizationLoaded({ organization }: { organization: OrganizationOwner }) {
	const { state, replace, reload } = useSection({ section: "organization", organization });
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
					<OrganizationForm values={section.values} replace={replace} reload={reload} />
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
	const set = (k: keyof Form) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });

	const save = () => {
		setChecked(true);
		if (Object.keys(errors).length > 0) return;
		void runSave(async (sent) => {
			const patch = Object.fromEntries(
				FIELDS.filter((k) => sent[k].trim() !== saved[k]).map((k) => [
					k,
					k === "name" ? sent.name.trim() : sent[k].trim() === "" ? null : sent[k].trim(),
				]),
			);
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
