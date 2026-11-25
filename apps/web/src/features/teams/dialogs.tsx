"use client";

import { Alert02Icon, Crown02Icon, UserAdd01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { Checkbox, Field, Input, Radio, RadioGroup, Select, Textarea, ProblemText } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { useState, type ReactNode } from "react";
import type { Wait } from "../../components/save/model.ts";
import { changesKept, CHOOSE_FIRST, type ConflictField } from "../../components/save/conflict.ts";
import { RecordDialog } from "../../components/save/parts.tsx";
import { useMergedDraft } from "../../components/save/useMergedDraft.ts";
import { SaveConflict } from "../../components/save/SaveConflict.tsx";
import { PersonPicker, type PickedPerson } from "../meetings/dialogs.tsx";
import { ICON_KEYS, ICONS, STATE_HINT, STATE_LABEL, STATES, type IconKey, type Role, type TeamState } from "./model.ts";

const NAME_MAX = 200;
const TEXT_MAX = 2000;
const blank = (s: string) => s.trim() === "";
export const optional = (s: string) => (blank(s) ? null : s.trim());

export type TeamDraft = {
	name: string;
	description: string;
	icon: IconKey;
	state: TeamState;
	reason: string;
};
export type TeamForm = TeamDraft & {
	mode: "create" | "edit";
	base?: TeamDraft;
	problem?: string;
};

const TEAM = "this ministry";
const TEAM_FIELDS: readonly ConflictField<TeamDraft>[] = [
	{ key: "name", label: "Name", text: (d) => d.name },
	{ key: "description", label: "What this ministry does", text: (d) => d.description },
	{ key: "icon", label: "Icon", text: (d) => ICONS[d.icon].label },
	{ key: "state", label: "State", text: (d) => STATE_LABEL[d.state] },
];
const teamDraft = ({ name, description, icon, state, reason }: TeamDraft): TeamDraft => ({
	name,
	description,
	icon,
	state,
	reason,
});

const DIALOG = {
	create: { title: "New ministry", action: "Create ministry", description: "A team of people who serve together." },
	edit: { title: "Edit details", action: "Save changes", description: undefined },
} as const;

export function TeamDialog({
	form,
	latest,
	problem,
	wait,
	onClose,
	onSubmit,
}: {
	form: TeamForm;
	latest?: TeamDraft;
	problem?: string;
	wait: Wait;
	onClose: () => void;
	onSubmit: (form: TeamForm) => void;
}) {
	const start = teamDraft(form);
	const base = form.base ?? start;
	const merged = useMergedDraft({
		base,
		latest: latest ? { ...latest, reason: base.reason } : base,
		start,
		fields: TEAM_FIELDS,
	});
	const { values: f, set } = merged;
	const [touched, setTouched] = useState(false);
	const noName = blank(f.name);
	const copy = DIALOG[form.mode];
	const conflicted = form.problem === "conflict";
	return (
		<RecordDialog
			icon={UserGroupIcon}
			title={copy.title}
			description={copy.description}
			action={copy.action}
			problem={
				merged.rows.length
					? touched && merged.unchosen
						? CHOOSE_FIRST
						: undefined
					: conflicted
						? changesKept(TEAM)
						: problem
			}
			conflict={
				<SaveConflict
					what={TEAM}
					rows={merged.rows}
					asked={touched}
					focus={conflicted}
					onPick={merged.choose}
					onKeepSaved={onClose}
				/>
			}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (noName || merged.unchosen) return false;
				onSubmit({ ...f, mode: form.mode, base: latest ?? form.base });
				return true;
			}}
		>
			<Field label="Name" error={touched && noName ? "Enter a name." : null}>
				<Input value={f.name} maxLength={NAME_MAX} onChange={(e) => set({ name: e.target.value })} />
			</Field>
			<Field label="What this ministry does" optional>
				<Textarea
					value={f.description}
					rows={2}
					maxLength={TEXT_MAX}
					onChange={(e) => set({ description: e.target.value })}
				/>
			</Field>
			<Field label="Icon">
				<Select
					value={f.icon}
					onValueChange={(v) => set({ icon: v as IconKey })}
					options={ICON_KEYS.map((k) => ({ value: k, label: ICONS[k].label }))}
					renderValue={(o) => <IconOption icon={o.value as IconKey} />}
				/>
			</Field>
			<fieldset className="flex flex-col gap-1">
				<legend className="mb-1 text-sm font-medium text-ink-2">State</legend>
				<RadioGroup value={f.state} onValueChange={(v) => set({ state: v as TeamState })} aria-label="State">
					{STATES.map((s) => (
						<Radio key={s} value={s} label={STATE_LABEL[s]} description={STATE_HINT[s]} />
					))}
				</RadioGroup>
			</fieldset>
			{form.mode === "edit" ? (
				<Field label="Reason for change" optional hint="It stays in this ministry's history.">
					<Textarea value={f.reason} rows={2} maxLength={500} onChange={(e) => set({ reason: e.target.value })} />
				</Field>
			) : null}
		</RecordDialog>
	);
}

function IconOption({ icon }: { icon: IconKey }) {
	return (
		<span className="flex items-center gap-2">
			<Icon icon={ICONS[icon].icon} size={16} className="text-text-2" />
			{ICONS[icon].label}
		</span>
	);
}

export type RoleDraft = {
	name: string;
	description: string;
	leadership: boolean;
	timeCommitment: string;
	desiredSkills: string;
};
export type RoleForm = RoleDraft & {
	roleId: string | null;
	revision: string;
	base?: RoleDraft;
	problem?: string;
};

const ROLE = "this role";
const ROLE_FIELDS: readonly ConflictField<RoleDraft>[] = [
	{ key: "name", label: "Name", text: (d) => d.name },
	{ key: "description", label: "Description", text: (d) => d.description },
	{ key: "timeCommitment", label: "Time each week", text: (d) => d.timeCommitment },
	{ key: "desiredSkills", label: "Skills that help", text: (d) => d.desiredSkills },
	{ key: "leadership", label: "Leadership role", text: (d) => (d.leadership ? "Yes" : "No") },
];
const roleDraft = ({ name, description, leadership, timeCommitment, desiredSkills }: RoleDraft): RoleDraft => ({
	name,
	description,
	leadership,
	timeCommitment,
	desiredSkills,
});
export const roleForm = (role: Role | null): RoleForm => ({
	roleId: role?.id ?? null,
	revision: role?.revision ?? "",
	name: role?.name ?? "",
	description: role?.description ?? "",
	leadership: role?.leadership ?? false,
	timeCommitment: role?.timeCommitment ?? "",
	desiredSkills: role?.desiredSkills ?? "",
});

export function RoleDialog({
	form,
	latest,
	problem,
	wait,
	onClose,
	onSubmit,
}: {
	form: RoleForm;
	latest?: RoleForm;
	problem?: string;
	wait: Wait;
	onClose: () => void;
	onSubmit: (form: RoleForm) => void;
}) {
	const start = roleDraft(form);
	const base = form.base ?? start;
	const merged = useMergedDraft({ base, latest: latest ? roleDraft(latest) : base, start, fields: ROLE_FIELDS });
	const { values: f, set } = merged;
	const [touched, setTouched] = useState(false);
	const conflicted = form.problem === "conflict";
	const noName = blank(f.name);
	return (
		<RecordDialog
			icon={UserAdd01Icon}
			title={form.roleId ? "Edit role" : "New role"}
			description="Each role is one place for one person."
			action={form.roleId ? "Save changes" : "Add role"}
			problem={
				merged.rows.length
					? touched && merged.unchosen
						? CHOOSE_FIRST
						: undefined
					: conflicted
						? changesKept(ROLE)
						: problem
			}
			conflict={
				<SaveConflict
					what={ROLE}
					rows={merged.rows}
					asked={touched}
					focus={conflicted}
					onPick={merged.choose}
					onKeepSaved={onClose}
				/>
			}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (noName || merged.unchosen) return false;
				onSubmit({
					...f,
					roleId: form.roleId,
					revision: latest?.revision ?? form.revision,
					base: latest ? roleDraft(latest) : form.base,
				});
				return true;
			}}
		>
			<Field label="Name" error={touched && noName ? "Enter a name." : null}>
				<Input value={f.name} maxLength={NAME_MAX} onChange={(e) => set({ name: e.target.value })} />
			</Field>
			<Field label="Description" optional>
				<Textarea
					value={f.description}
					rows={2}
					maxLength={TEXT_MAX}
					onChange={(e) => set({ description: e.target.value })}
				/>
			</Field>
			<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
				<Field label="Time each week" optional>
					<Input
						value={f.timeCommitment}
						maxLength={TEXT_MAX}
						placeholder="2 hours"
						onChange={(e) => set({ timeCommitment: e.target.value })}
					/>
				</Field>
				<Field label="Skills that help" optional>
					<Input
						value={f.desiredSkills}
						maxLength={TEXT_MAX}
						placeholder="Audio mixing"
						onChange={(e) => set({ desiredSkills: e.target.value })}
					/>
				</Field>
			</div>
			<Checkbox
				checked={f.leadership}
				onCheckedChange={(v) => set({ leadership: v === true })}
				label="Leadership role"
				description="When the ministry has no leader, the person in this role becomes its leader."
			/>
		</RecordDialog>
	);
}

export type PersonForm = { person: PickedPerson | null; roleId: string | null; problem?: string };

export function PersonDialog({
	title,
	description,
	action,
	icon = UserAdd01Icon,
	form,
	roles,
	exclude,
	problem,
	wait,
	note,
	onClose,
	onSubmit,
}: {
	title: string;
	description?: ReactNode;
	action: string;
	icon?: typeof UserAdd01Icon;
	form: PersonForm;
	roles: Role[] | null;
	exclude?: string[];
	problem?: string;
	wait: Wait;
	note?: ReactNode;
	onClose: () => void;
	onSubmit: (form: PersonForm, person: PickedPerson) => void;
}) {
	const [f, setF] = useState(form);
	const [touched, setTouched] = useState(false);
	const noPerson = f.person === null;
	const noRole = roles !== null && f.roleId === null;
	return (
		<RecordDialog
			icon={icon}
			title={title}
			description={description}
			action={action}
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				const { person } = f;
				if (person === null || noRole) return false;
				onSubmit(f, person);
				return true;
			}}
		>
			{roles !== null ? (
				<Field label="Role" error={touched && noRole ? "Choose a role." : null}>
					<Select
						value={f.roleId ?? ""}
						placeholder="Choose an open role"
						onValueChange={(v) => setF((x) => ({ ...x, roleId: v }))}
						options={roles.map((r) => ({ value: r.id, label: r.name }))}
					/>
				</Field>
			) : null}
			<div className="flex flex-col gap-1.5" data-invalid={touched && noPerson ? true : undefined}>
				<p className="text-sm font-medium text-ink-2">Person</p>
				<PersonPicker
					label="Person"
					value={f.person}
					exclude={exclude}
					onChange={(person) => setF((x) => ({ ...x, person }))}
				/>
				{touched && noPerson ? <ProblemText icon={Alert02Icon}>Choose a person.</ProblemText> : null}
			</div>
			{note}
		</RecordDialog>
	);
}

export const LEADER_ICON = Crown02Icon;
