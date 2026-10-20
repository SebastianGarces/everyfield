"use client";

import { Button, Field, Input, SegmentedControl, Select, Skeleton, Textarea } from "@everyfield/ui/controls";
import { LoadableView } from "@everyfield/ui/display";
import { useState } from "react";
import { canDeleteWorkspace } from "../model";
import type { DeletionStatus, DigestSchedule, PlantOwner, PlantSettings, SectionResult } from "../port";
import { attempt } from "../save";
import { SaveError, SaveFooter, SectionBody, SettingRow } from "../SettingsDialog";
import { useDraft, useSection, useSettings } from "../store";
import { hourLabel, WEEKDAYS, zoneLabel } from "../time";
import { PlantTimezoneDialog } from "../flows/PlantTimezoneDialog";
import { WorkspaceDeletionDialog } from "../flows/DeletionDialogs";

type PlantSection = Extract<SectionResult, { section: "plant" }>;

// Text inputs hold strings; an empty optional field saves as null (REQ-IDN-011: independent nullable fields).
type Form = {
	name: string;
	street: string;
	city: string;
	stateProvince: string;
	country: string;
	description: string;
	warningDays: string;
	alertDays: string;
	digest: DigestSchedule;
};

function formOf(values: PlantSettings): Form {
	const p = values.profile;
	return {
		name: p.name,
		street: p.street ?? "",
		city: p.city ?? "",
		stateProvince: p.stateProvince ?? "",
		country: p.country ?? "",
		description: p.description ?? "",
		warningDays: String(values.inactivity.warningDays),
		alertDays: String(values.inactivity.alertDays),
		digest: values.digest,
	};
}

type Errors = Partial<Record<keyof Form, string>>;

const LIMIT = { name: 200, street: 500, city: 200, stateProvince: 200, country: 200, description: 5000 } as const;

export function validate(form: Form): Errors {
	const errors: Errors = {};
	if (!form.name.trim()) errors.name = "Enter your church's name.";
	for (const key of Object.keys(LIMIT) as (keyof typeof LIMIT)[]) {
		if (form[key].trim().length > LIMIT[key])
			errors[key] = `Use ${LIMIT[key].toLocaleString("en-US")} characters or fewer.`;
	}
	const warning = Number(form.warningDays);
	const alert = Number(form.alertDays);
	if (!/^\d+$/.test(form.warningDays) || warning < 1 || warning > 365) errors.warningDays = "Enter 1 to 365 days.";
	if (!/^\d+$/.test(form.alertDays) || alert < 1 || alert > 365) errors.alertDays = "Enter 1 to 365 days.";
	if (!errors.warningDays && !errors.alertDays && warning >= alert)
		errors.alertDays = "Inactive must come after the warning.";
	return errors;
}

const nullable = (v: string) => (v.trim() === "" ? null : v.trim());

export function ChurchSection({ onDeletionRequested }: { onDeletionRequested: (status: DeletionStatus) => void }) {
	const { viewer } = useSettings();
	if (viewer.context !== "plant") return null;
	return <ChurchLoaded plant={viewer.plant} onDeletionRequested={onDeletionRequested} />;
}

function ChurchLoaded({
	plant,
	onDeletionRequested,
}: {
	plant: PlantOwner;
	onDeletionRequested: (status: DeletionStatus) => void;
}) {
	const { state, replace, reload } = useSection({ section: "plant", plant });
	return (
		<LoadableView
			state={state}
			empty={{ title: "" }}
			loadingLabel="Loading church profile"
			skeleton={
				<SectionBody>
					<div className="flex flex-col gap-6 pt-4">
						{[0, 1, 2, 3].map((i) => (
							<Skeleton key={i} shape="block" height={44} />
						))}
					</div>
				</SectionBody>
			}
		>
			{(section) => (
				<ChurchForm section={section} replace={replace} reload={reload} onDeletionRequested={onDeletionRequested} />
			)}
		</LoadableView>
	);
}

function ChurchForm({
	section,
	replace,
	reload,
	onDeletionRequested,
}: {
	section: PlantSection;
	replace: (value: SectionResult) => void;
	reload: () => void;
	onDeletionRequested: (status: DeletionStatus) => void;
}) {
	const { port, viewer } = useSettings();
	const saved = formOf(section.values);
	const { draft, setDraft, dirty, saving, refusal, save: runSave } = useDraft<Form>("church", saved);
	const [showErrors, setShowErrors] = useState(false);
	const [zoneOpen, setZoneOpen] = useState(false);
	const [zoneSession, setZoneSession] = useState(0);
	const errors = validate(draft);
	const visible = showErrors ? errors : {};
	const set = <K extends keyof Form>(key: K, value: Form[K]) => setDraft({ ...draft, [key]: value });

	// One section save sends up to three contract changes as one write. A refusal saves none of them, keeps every
	// value in the draft and says why.
	const save = () => {
		setShowErrors(true);
		if (Object.keys(errors).length > 0) return;
		void runSave(async (sent) => {
			const patch = Object.fromEntries(
				(["name", "street", "city", "stateProvince", "country", "description"] as const)
					.filter((k) => sent[k].trim() !== saved[k])
					.map((k) => [k, k === "name" ? sent.name.trim() : nullable(sent[k])]),
			);
			const changes = [
				Object.keys(patch).length > 0 ? { kind: "profile" as const, patch } : null,
				sent.warningDays !== saved.warningDays || sent.alertDays !== saved.alertDays
					? {
							kind: "inactivity" as const,
							value: { warningDays: Number(sent.warningDays), alertDays: Number(sent.alertDays) },
						}
					: null,
				JSON.stringify(sent.digest) !== JSON.stringify(saved.digest)
					? { kind: "digest" as const, value: sent.digest }
					: null,
			].filter((c) => c !== null);
			if (changes.length === 0) return { ok: true, server: saved };
			const result = await attempt("plant-settings", (requestKey) =>
				port.saveChurch({
					requestKey,
					expectedRevision: section.revision,
					input: { plant: section.plant, changes },
				}),
			);
			if (!result.ok) return { ok: false, refusal: result.refusal };
			const current = result.value.current.section === "plant" ? result.value.current : section;
			replace(current);
			return { ok: true, server: formOf(current.values) };
		});
	};

	const loadLatest =
		refusal && (refusal.code === "conflict" || refusal.code === "unknown") ? (
			<Button size="sm" variant="secondary" onClick={reload}>
				Load latest
			</Button>
		) : undefined;

	return (
		<>
			<SectionBody>
				<SettingRow label="Name" description="Shown on every document.">
					<Field label={<span className="sr-only">Church name</span>} error={visible.name}>
						<Input
							value={draft.name}
							onChange={(e) => set("name", e.target.value)}
							autoComplete="organization"
							invalid={Boolean(visible.name)}
						/>
					</Field>
				</SettingRow>
				<SettingRow
					label="Address"
					description="All optional. City, region and country place you in Plant Intelligence. The street stays private to your church."
				>
					<div className="flex flex-col gap-3">
						<Field label="Street" error={visible.street}>
							<Input
								value={draft.street}
								onChange={(e) => set("street", e.target.value)}
								autoComplete="street-address"
							/>
						</Field>
						<div className="grid grid-cols-3 gap-3 max-app-sm:grid-cols-1">
							<Field label="City" error={visible.city}>
								<Input value={draft.city} onChange={(e) => set("city", e.target.value)} autoComplete="address-level2" />
							</Field>
							<Field label="State or province" error={visible.stateProvince}>
								<Input
									value={draft.stateProvince}
									onChange={(e) => set("stateProvince", e.target.value)}
									autoComplete="address-level1"
								/>
							</Field>
							<Field label="Country" error={visible.country}>
								<Input
									value={draft.country}
									onChange={(e) => set("country", e.target.value)}
									autoComplete="country-name"
								/>
							</Field>
						</div>
					</div>
				</SettingRow>
				<SettingRow label="About" description="Optional. A few sentences for your church page.">
					<Field label={<span className="sr-only">About your church</span>} error={visible.description}>
						<Textarea
							value={draft.description}
							onChange={(e) => set("description", e.target.value)}
							invalid={Boolean(visible.description)}
						/>
					</Field>
				</SettingRow>
				<SettingRow label="Time zone" description="Sets due dates, reminders and the start of each week.">
					<div className="flex flex-wrap items-center gap-3">
						<span className="font-medium text-ink">{zoneLabel(section.values.timeZone)}</span>
						<Button
							size="sm"
							variant="secondary"
							onClick={() => {
								setZoneSession((n) => n + 1);
								setZoneOpen(true);
							}}
						>
							Change time zone
						</Button>
					</div>
				</SettingRow>
				<SettingRow
					label="Inactive after"
					description="People with no contact get a warning badge first, then an inactive badge."
				>
					<div className="grid max-w-[360px] grid-cols-2 gap-3">
						<Field label="Warning after (days)" error={visible.warningDays}>
							<Input
								inputMode="numeric"
								value={draft.warningDays}
								onChange={(e) => set("warningDays", e.target.value.trim())}
								invalid={Boolean(visible.warningDays)}
							/>
						</Field>
						<Field label="Inactive after (days)" error={visible.alertDays}>
							<Input
								inputMode="numeric"
								value={draft.alertDays}
								onChange={(e) => set("alertDays", e.target.value.trim())}
								invalid={Boolean(visible.alertDays)}
							/>
						</Field>
					</div>
				</SettingRow>
				<SettingRow label="Church digest" description="Open items sent to each seat that gets the digest.">
					<DigestControl value={draft.digest} onChange={(digest) => set("digest", digest)} />
				</SettingRow>
				{port.flows && canDeleteWorkspace(viewer) ? (
					<SettingRow
						label="Delete church workspace"
						description="Only the Owner can do this. You have 30 days to cancel."
					>
						<WorkspaceDeletionDialog section={section} onRequested={onDeletionRequested} />
					</SettingRow>
				) : null}
			</SectionBody>
			<SaveFooter
				section="church"
				dirty={dirty}
				saving={saving}
				onSave={save}
				error={
					refusal ? (
						<SaveError message={refusal.message} reference={refusal.reference} action={loadLatest} />
					) : showErrors && Object.keys(errors).length > 0 ? (
						<SaveError message="Some values need a change before you can save. They are marked in red." />
					) : undefined
				}
			/>
			<PlantTimezoneDialog
				key={zoneSession}
				open={zoneOpen}
				onOpenChange={setZoneOpen}
				section={section}
				onSaved={replace}
			/>
		</>
	);
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) }));
const DAYS = WEEKDAYS.map((label, i) => ({ value: String(i), label }));

/** Off, daily at an hour, or weekly on a day at an hour (digestSchedule). The defaults are Sunday at 4:00 PM. */
function DigestControl({ value, onChange }: { value: DigestSchedule; onChange: (next: DigestSchedule) => void }) {
	const hour = value.cadence === "off" ? 16 : value.hour;
	const weekday = value.cadence === "weekly" ? value.weekday : 0;
	return (
		<div className="flex flex-wrap items-center gap-3">
			<SegmentedControl
				label="Digest schedule"
				value={value.cadence}
				onValueChange={(cadence) =>
					onChange(
						cadence === "off" ? { cadence } : cadence === "daily" ? { cadence, hour } : { cadence, weekday, hour },
					)
				}
				options={[
					{ value: "off", label: "Off" },
					{ value: "daily", label: "Daily" },
					{ value: "weekly", label: "Weekly" },
				]}
			/>
			{value.cadence === "weekly" ? (
				<Select
					aria-label="Digest day"
					className="w-[150px]"
					options={DAYS}
					value={String(value.weekday)}
					onValueChange={(v) => onChange({ ...value, weekday: Number(v) })}
				/>
			) : null}
			{value.cadence !== "off" ? (
				<Select
					aria-label="Digest time"
					className="w-[130px]"
					options={HOURS}
					value={String(value.hour)}
					onValueChange={(v) => onChange({ ...value, hour: Number(v) })}
				/>
			) : (
				<span className="text-sm text-text-3">No church digest is sent.</span>
			)}
		</div>
	);
}
