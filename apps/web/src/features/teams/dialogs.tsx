"use client";

import { Alert02Icon, Crown02Icon, UserAdd01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { Checkbox, Field, Input, Radio, RadioGroup, Select, Textarea } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { useState, type ReactNode } from "react";
import type { Wait } from "../../components/save/model.ts";
import { RecordDialog } from "../../components/save/parts.tsx";
import { PersonPicker, type PickedPerson } from "../meetings/dialogs.tsx";
import { ICON_KEYS, ICONS, STATE_HINT, STATE_LABEL, STATES, type IconKey, type Role, type TeamState } from "./model.ts";

// The forms of the teams screens. Each one belongs to a card's save lane (components/save): a save closes it, and a
// refusal opens it again with what was entered and the reason in words.

const NAME_MAX = 200;
const TEXT_MAX = 2000;
const blank = (s: string) => s.trim() === "";
/** An optional text field as the contract takes it: trimmed, or null to clear it. */
export const optional = (s: string) => (blank(s) ? null : s.trim());

export type TeamForm = {
	mode: "create" | "edit";
	name: string;
	description: string;
	icon: IconKey;
	state: TeamState;
	reason: string;
	problem?: string;
};

const DIALOG = {
	create: { title: "New ministry", action: "Create ministry", description: "A team of people who serve together." },
	edit: { title: "Edit details", action: "Save changes", description: undefined },
} as const;

export function TeamDialog({
	form,
	problem,
	wait,
	onClose,
	onSubmit,
}: {
	form: TeamForm;
	problem?: string;
	wait: Wait;
	onClose: () => void;
	onSubmit: (form: TeamForm) => void;
}) {
	const [f, setF] = useState(form);
	const [touched, setTouched] = useState(false);
	const set = (patch: Partial<TeamForm>) => setF((x) => ({ ...x, ...patch }));
	const noName = blank(f.name);
	const copy = DIALOG[f.mode];
	return (
		<RecordDialog
			icon={UserGroupIcon}
			title={copy.title}
			description={copy.description}
			action={copy.action}
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (noName) return false;
				onSubmit(f);
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
						<Radio key={s} value={s} label={STATE_LABEL[s]} description={STATE_HINT[s]} className="py-2" />
					))}
				</RadioGroup>
			</fieldset>
			{f.mode === "edit" ? (
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

export type RoleForm = {
	roleId: string | null;
	revision: string;
	name: string;
	description: string;
	leadership: boolean;
	timeCommitment: string;
	desiredSkills: string;
	problem?: string;
};
export const roleForm = (role: Role | null): RoleForm => ({
	roleId: role?.id ?? null,
	revision: role?.revision ?? "",
	name: role?.name ?? "",
	description: role?.description ?? "",
	leadership: role?.leadership ?? false,
	timeCommitment: role?.timeCommitment ?? "",
	desiredSkills: role?.desiredSkills ?? "",
});

/** One role slot: one person at a time. A leadership role fills an empty leader seat when someone takes it. */
export function RoleDialog({
	form,
	problem,
	wait,
	onClose,
	onSubmit,
}: {
	form: RoleForm;
	problem?: string;
	wait: Wait;
	onClose: () => void;
	onSubmit: (form: RoleForm) => void;
}) {
	const [f, setF] = useState(form);
	const [touched, setTouched] = useState(false);
	const set = (patch: Partial<RoleForm>) => setF((x) => ({ ...x, ...patch }));
	const noName = blank(f.name);
	return (
		<RecordDialog
			icon={UserAdd01Icon}
			title={f.roleId ? "Edit role" : "New role"}
			description="Each role is one place for one person."
			action={f.roleId ? "Save changes" : "Add role"}
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				if (noName) return false;
				onSubmit(f);
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

/**
 * Choose a person, and for Add member also the open role they take. The search reads only after the person types.
 * `roles` null means the role is already chosen (Fill on a role, or a leader appointment).
 */
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
	onSubmit: (form: PersonForm) => void;
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
				if (noPerson || noRole) return false;
				onSubmit(f);
				return true;
			}}
		>
			{roles !== null ? (
				<Field label="Role" error={touched && noRole ? "Choose a role." : null}>
					<Select
						value={f.roleId ?? undefined}
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
				{touched && noPerson ? (
					<p role="alert" className="flex items-center gap-1.5 text-xs text-magenta-600">
						<Icon icon={Alert02Icon} size={16} />
						Choose a person.
					</p>
				) : null}
			</div>
			{note}
		</RecordDialog>
	);
}

/** The icon for a leader appointment dialog. */
export const LEADER_ICON = Crown02Icon;
