"use client";

import { Add01Icon, Delete02Icon, Edit02Icon, MoreHorizontalIcon, StarIcon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardHeader,
	CardHeading,
	CardTitle,
	Field,
	IconButton,
	Input,
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
	Select,
	Textarea,
} from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { useOptimistic, useState, useTransition } from "react";
import type { Wait } from "../../../components/save/model.ts";
import { NoticeInDialog, RecordDialog, SaveNotice, useSaveIntent } from "../../../components/save/parts.tsx";
import type { Receipt } from "../boundary.ts";
import { fresh, problemText } from "../parts.tsx";
import { addSkill, readSkills, removeSkill, updateSkill } from "./actions.ts";
import {
	CATEGORY_LABEL,
	PROFICIENCIES,
	PROFICIENCY_LABEL,
	SKILL_CATEGORIES,
	skillGroups,
	type Proficiency,
	type Skill,
	type SkillCategory,
} from "./model.ts";

type Draft = { name: string; category: SkillCategory | ""; proficiency: Proficiency | "none"; notes: string };
type Editing = { skill: Skill | null; draft: Draft; problem?: string };
type Change = { put: Skill } | { remove: string };
/** The words for a refused skill change. */
const skillProblem = (code: string) =>
	code === "conflict"
		? "This skill changed while you were working. The latest skills show now. Check them and try again."
		: problemText(code);
const EMPTY: Draft = { name: "", category: "", proficiency: "none", notes: "" };
const draftOf = (s: Skill): Draft => ({
	name: s.name,
	category: s.category,
	proficiency: s.proficiency ?? "none",
	notes: s.notes ?? "",
});

/**
 * Skills and gifts (REQ-PPL-011), grouped by category in the requirement's order. A change shows at once while it saves
 * through the card's save lane (components/save): one save at a time, its own request key, one replay after a lost
 * answer and Check again when the answer stays unknown, so a retry never adds a second skill. A refused add or edit
 * opens the form again with the text kept; a conflict reads the skills again. These are recorded facts: they never
 * stand in for the Gifted interview criterion or say a person is called or ready.
 */
export function SkillsCard({
	personId,
	personName,
	initial,
	canEdit,
	onSaved,
}: {
	personId: string;
	personName: string;
	/** Null when skills did not load. */
	initial: Skill[] | null;
	canEdit: boolean;
	onSaved: (receipt: Receipt) => void;
}) {
	const [skills, setSkills] = useState<Skill[]>(initial ?? []);
	const [shown, apply] = useOptimistic(skills, (current, change: Change) =>
		"put" in change
			? [...current.filter((s) => s.id !== change.put.id), change.put]
			: current.filter((s) => s.id !== change.remove),
	);
	const [, start] = useTransition();
	const form = useSaveIntent<Editing>({ explain: skillProblem });
	const first = personName.split(" ")[0] ?? personName;
	const saved = (value: { skills: Skill[]; receipt: Receipt }) => {
		setSkills(value.skills);
		onSaved(value.receipt);
	};
	/** A conflict: another change moved a skill on, so the card shows the skills as saved now. */
	const reload = async (code: string) => {
		if (code !== "conflict") return;
		const r = await readSkills(personId).catch(() => null);
		if (r?.status === "ok") setSkills(r.value);
	};

	function submit(target: Skill | null, draft: Draft) {
		if (!draft.category) return;
		const values = {
			name: draft.name.trim(),
			category: draft.category,
			proficiency: draft.proficiency === "none" ? null : draft.proficiency,
			notes: draft.notes.trim() || null,
		};
		start(async () => {
			apply({ put: { ...(target ?? { id: `new:${fresh()}`, personId, revision: "0" }), ...values } as Skill });
			await form.save({
				what: values.name,
				done: target ? "saved" : "added",
				form: { skill: target, draft },
				send: (key) =>
					target
						? updateSkill(key, target.revision, { skillId: target.id, patch: values })
						: addSkill(key, { personId, ...values }),
				refused: reload,
				ok: saved,
			});
		});
	}
	function remove(skill: Skill) {
		start(async () => {
			apply({ remove: skill.id });
			await form.save({
				what: skill.name,
				done: "removed",
				send: (key) => removeSkill(key, skill.revision, skill.id),
				refused: reload,
				ok: saved,
			});
		});
	}

	const groups = skillGroups(shown);
	return (
		<Card>
			<CardHeader className="mb-2">
				<CardHeading>
					<CardTitle size="sm">Skills and gifts</CardTitle>
				</CardHeading>
				{canEdit && groups.length > 0 ? (
					<IconButton
						icon={Add01Icon}
						label="Add a skill"
						size="sm"
						onClick={() => form.open({ skill: null, draft: EMPTY })}
					/>
				) : null}
			</CardHeader>
			<SaveNotice {...form.noticeProps} dialogOpen={form.editing !== null} />
			{initial === null ? (
				<p className="text-sm text-text-3">Skills did not load. Reload the page to see them.</p>
			) : groups.length === 0 ? (
				<div className="flex flex-col items-start gap-3">
					<p className="text-sm text-text-3">No skills recorded for {first}.</p>
					{canEdit ? (
						<Button
							size="sm"
							variant="secondary"
							icon={Add01Icon}
							onClick={() => form.open({ skill: null, draft: EMPTY })}
						>
							Add a skill
						</Button>
					) : null}
				</div>
			) : (
				<div className="flex flex-col gap-4">
					{groups.map((g) => (
						<section key={g.category} aria-labelledby={`skills-${g.category}`}>
							<h3
								id={`skills-${g.category}`}
								className="mb-1 font-sans text-xs font-medium tracking-normal text-text-3"
							>
								{CATEGORY_LABEL[g.category]}
							</h3>
							<ul className="flex flex-col">
								{g.skills.map((s) => (
									<SkillRow
										key={s.id}
										skill={s}
										canEdit={canEdit}
										wait={form.wait}
										onEdit={() => form.open({ skill: s, draft: draftOf(s) })}
										onRemove={() => remove(s)}
									/>
								))}
							</ul>
						</section>
					))}
				</div>
			)}
			<p className="mt-3 text-xs text-text-3">Recorded skills only. They do not decide calling or readiness.</p>
			<NoticeInDialog {...form.noticeProps}>
				{form.editing ? (
					<SkillDialog
						editing={form.editing}
						problem={form.problem}
						wait={form.wait}
						personName={first}
						onClose={form.close}
						onSubmit={(draft) => submit(form.editing?.skill ?? null, draft)}
					/>
				) : null}
			</NoticeInDialog>
		</Card>
	);
}

function SkillRow({
	skill,
	canEdit,
	wait,
	onEdit,
	onRemove,
}: {
	skill: Skill;
	canEdit: boolean;
	/** The card's last save is in flight or unknown (C68): no other change can start. */
	wait: Wait;
	onEdit: () => void;
	onRemove: () => void;
}) {
	const pending = skill.id.startsWith("new:");
	return (
		<li
			className="flex items-start gap-3 border-t border-line py-2.5 first:border-t-0"
			aria-busy={pending || undefined}
		>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium text-ink [overflow-wrap:anywhere]">{skill.name}</span>
					{skill.proficiency ? (
						<Tag className="h-[22px] px-2 text-xs">{PROFICIENCY_LABEL[skill.proficiency]}</Tag>
					) : null}
					{pending ? <span className="text-xs text-text-3">Saving…</span> : null}
				</div>
				{skill.notes ? (
					<p className="mt-1 line-clamp-3 text-sm whitespace-pre-wrap text-text-2 [overflow-wrap:anywhere]">
						{skill.notes}
					</p>
				) : null}
			</div>
			{canEdit && !pending ? (
				<Menu>
					<MenuTrigger asChild>
						<IconButton icon={MoreHorizontalIcon} label={`Actions for ${skill.name}`} size="sm" />
					</MenuTrigger>
					<MenuContent align="end">
						<MenuItem icon={Edit02Icon} onSelect={onEdit}>
							Edit skill
						</MenuItem>
						<MenuSeparator />
						<MenuItem icon={Delete02Icon} danger disabled={wait !== null} onSelect={onRemove}>
							Remove skill
						</MenuItem>
					</MenuContent>
				</Menu>
			) : null}
		</li>
	);
}

function SkillDialog({
	editing,
	problem,
	wait,
	personName,
	onClose,
	onSubmit,
}: {
	editing: Editing;
	problem: string | undefined;
	wait: Wait;
	personName: string;
	onClose: () => void;
	onSubmit: (draft: Draft) => void;
}) {
	const [draft, setDraft] = useState(editing.draft);
	const [touched, setTouched] = useState(false);
	const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
	const nameMissing = draft.name.trim() === "";
	const categoryMissing = draft.category === "";
	return (
		<RecordDialog
			icon={StarIcon}
			tone="green"
			title={editing.skill ? `Edit ${editing.skill.name}` : `Add a skill for ${personName}`}
			description="What they can do or have done. You can leave the level blank."
			action={editing.skill ? "Save skill" : "Add skill"}
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={() => {
				setTouched(true);
				const ok = !nameMissing && !categoryMissing;
				if (ok) onSubmit(draft);
				return ok;
			}}
		>
			<Field label="Skill" error={touched && nameMissing ? "Name the skill, such as Piano or Hosting." : null}>
				<Input value={draft.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} />
			</Field>
			<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
				<Field label="Category" error={touched && categoryMissing ? "Choose a category." : null}>
					<Select
						value={draft.category}
						placeholder="Choose a category"
						onValueChange={(category) => set({ category: category as SkillCategory })}
						options={SKILL_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
					/>
				</Field>
				<Field label="Level" optional>
					<Select
						value={draft.proficiency}
						onValueChange={(proficiency) => set({ proficiency: proficiency as Draft["proficiency"] })}
						options={[
							{ value: "none", label: "Not recorded" },
							...PROFICIENCIES.map((p) => ({ value: p, label: PROFICIENCY_LABEL[p] })),
						]}
					/>
				</Field>
			</div>
			<Field label="Notes" optional>
				<Textarea value={draft.notes} maxLength={5000} rows={3} onChange={(e) => set({ notes: e.target.value })} />
			</Field>
		</RecordDialog>
	);
}
