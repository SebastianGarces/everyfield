"use client";

import { Delete02Icon, Edit02Icon, MoreHorizontalIcon, Tag01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	ConfirmDialog,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	IconButton,
	Input,
	Menu,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuTrigger,
	Skeleton,
} from "@everyfield/ui/controls";
import { TINT, type Tone } from "@everyfield/ui/display";
import { cn } from "@everyfield/ui/foundations";
import { useOptimistic, useState, useTransition } from "react";
import { createRead, useRead } from "../../../components/read.tsx";
import type { Outcome } from "../../../components/save/model.ts";
import { DialogNotice, type SaveIntent } from "../../../components/save/parts.tsx";
import { FormProblem, problemText } from "../parts.tsx";
import { createChurchTag, deleteChurchTag, updateChurchTag } from "./actions.ts";
import { listChurchTags } from "../fetch.ts";
import { TAG_COLOR_LABEL, TAG_COLORS, tagLook, type ChurchTag } from "./model.ts";

export const churchTags = createRead((): Promise<Outcome<ChurchTag[]>> => listChurchTags(), {
	failed: () => ({ status: "lost" }) as const,
});
const byName = (a: { name: string }, b: { name: string }) =>
	a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
const problem = (r: Outcome<unknown>) => (r.status === "ok" ? undefined : r.status === "lost" ? "lost" : r.code);
export const tagProblem = (code: string) =>
	code === "conflict"
		? "Another tag already has this name, or the tag changed. Check the list and try again."
		: problemText(code);

export function ManageTagsDialog({
	open,
	lane,
	onOpenChange,
	onChurchTags,
}: {
	open: boolean;
	lane: SaveIntent<{ problem?: string }>;
	onOpenChange: (open: boolean) => void;
	onChurchTags: (tags: ChurchTag[]) => void;
}) {
	const loaded = useRead(churchTags).value ?? null;
	const tags = loaded?.status === "ok" ? loaded.value : [];
	const [shown, apply] = useOptimistic(tags, (all, change: { put: ChurchTag } | { remove: string }) =>
		"put" in change
			? [...all.filter((t) => t.id !== change.put.id), change.put].sort(byName)
			: all.filter((t) => t.id !== change.remove),
	);
	const [, start] = useTransition();
	const [name, setName] = useState("");
	const [rowProblem, setRowProblem] = useState<{ id: string; text: string } | null>(null);
	const wait = lane.wait;
	const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
	const [deleting, setDeleting] = useState<ChurchTag | null>(null);
	const save = (update: (all: ChurchTag[]) => ChurchTag[]) => {
		const saved = churchTags.peek()?.value;
		const all = update(saved?.status === "ok" ? saved.value : []).sort(byName);
		churchTags.patch(() => ({ status: "ok", value: all }));
		onChurchTags(all);
	};

	async function confirmDelete(tag: ChurchTag) {
		setRowProblem(null);
		const r = await listChurchTags().catch(() => ({ status: "lost" }) as const);
		if (r.status !== "ok") return setRowProblem({ id: tag.id, text: tagProblem(problem(r)!) });
		save(() => r.value);
		const now = r.value.find((t) => t.id === tag.id);
		if (now) setDeleting(now);
	}

	function create(event: React.FormEvent) {
		event.preventDefault();
		const term = name.trim();
		if (!term || wait) return;
		setName("");
		start(async () => {
			apply({ put: { id: `new:${term}`, name: term, color: null, revision: "0", linkedPeople: 0 } as ChurchTag });
			await lane.save({
				what: term,
				done: "added",
				send: (key) => createChurchTag(key, { name: term }),
				refused: () => setName((now) => now || term),
				ok: (tag) => save((all) => [...all.filter((t) => t.id !== tag.id), tag]),
			});
		});
	}
	async function reload(code: string) {
		if (code !== "conflict") return;
		const r = await listChurchTags().catch(() => null);
		if (r?.status === "ok") save(() => r.value);
	}

	function remove(tag: ChurchTag) {
		setDeleting(null);
		setRowProblem(null);
		start(async () => {
			apply({ remove: tag.id });
			await lane.save({
				what: tag.name,
				done: "deleted",
				send: (key) => deleteChurchTag(key, tag.revision, tag.id),
				refused: reload,
				ok: () => save((all) => all.filter((t) => t.id !== tag.id)),
			});
		});
	}

	function change(tag: ChurchTag, patch: { name?: string; color?: string | null }) {
		setRowProblem(null);
		start(async () => {
			apply({ put: { ...tag, ...patch } as ChurchTag });
			await lane.save({
				what: tag.name,
				done: "changed",
				send: (key) => updateChurchTag(key, tag.revision, { tagId: tag.id, ...patch }),
				refused: (code) => {
					if (patch.name !== undefined) setRenaming({ id: tag.id, name: patch.name });
					void reload(code);
				},
				ok: (next) => save((all) => all.map((t) => (t.id === tag.id ? next : t))),
			});
		});
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader
					icon={Tag01Icon}
					tone="green"
					title="Church tags"
					description="Tags belong to your church. A change shows on everyone who has the tag."
				/>
				<DialogBody className="flex flex-col gap-4">
					<DialogNotice />
					<form onSubmit={create} className="flex items-start gap-2" noValidate>
						<Input
							aria-label="New tag name"
							placeholder="New tag name"
							value={name}
							maxLength={100}
							onChange={(e) => setName(e.target.value)}
						/>
						<Button type="submit" variant="secondary" disabled={!name.trim() || wait !== null}>
							Add tag
						</Button>
					</form>
					{loaded === null ? (
						<div aria-busy="true" className="flex flex-col gap-2">
							<span className="sr-only" role="status">
								Loading tags
							</span>
							<Skeleton className="h-11 rounded-md" />
							<Skeleton className="h-11 rounded-md" />
						</div>
					) : loaded.status !== "ok" ? (
						<FormProblem code={problem(loaded)} />
					) : shown.length === 0 ? (
						<p className="text-sm text-text-3">No tags yet. Add the first one above.</p>
					) : (
						<ul className="flex flex-col" aria-label="Tags">
							{shown.map((t) => (
								<li key={t.id} className="border-t border-line py-2 first:border-t-0">
									{renaming?.id === t.id ? (
										<RenameRow
											tag={t}
											initial={renaming.name}
											disabled={wait !== null}
											onCancel={() => setRenaming(null)}
											onSave={(next) => {
												setRenaming(null);
												if (next !== t.name) change(t, { name: next });
											}}
										/>
									) : (
										<div className="flex min-h-11 items-center gap-3">
											{t.id.startsWith("new:") ? (
												<span className="grid size-8 flex-none place-items-center">
													<Swatch />
												</span>
											) : (
												<ColorMenu tag={t} disabled={wait !== null} onColor={(color) => change(t, { color })} />
											)}
											<span className="min-w-0 flex-1 truncate font-medium text-ink">{t.name}</span>
											<span className="text-sm text-text-3 tabular-nums">
												{t.linkedPeople} {t.linkedPeople === 1 ? "person" : "people"}
											</span>
											{t.id.startsWith("new:") ? (
												<span role="status" className="text-xs text-text-3">
													Saving…
												</span>
											) : (
												<Menu>
													<MenuTrigger asChild>
														<IconButton icon={MoreHorizontalIcon} label={`Actions for ${t.name}`} size="sm" />
													</MenuTrigger>
													<MenuContent align="end">
														<MenuItem
															icon={Edit02Icon}
															disabled={wait !== null}
															onSelect={() => setRenaming({ id: t.id, name: t.name })}
														>
															Rename
														</MenuItem>
														<MenuSeparator />
														<MenuItem
															icon={Delete02Icon}
															danger
															disabled={wait !== null}
															onSelect={() => void confirmDelete(t)}
														>
															Delete tag
														</MenuItem>
													</MenuContent>
												</Menu>
											)}
										</div>
									)}
									{rowProblem?.id === t.id ? (
										<p role="alert" className="mt-1 text-xs font-medium text-magenta-600">
											{rowProblem.text}
										</p>
									) : null}
								</li>
							))}
						</ul>
					)}
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" onClick={() => onOpenChange(false)}>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
			{deleting ? (
				<ConfirmDialog
					open
					onOpenChange={(next) => !next && setDeleting(null)}
					tone="danger"
					title={`Delete ${deleting.name}?`}
					consequences={[
						deleting.linkedPeople === 0
							? "Nobody has this tag now."
							: `It comes off ${deleting.linkedPeople} ${deleting.linkedPeople === 1 ? "person" : "people"}.`,
						"Their history keeps a record of the tag.",
					]}
					confirmLabel="Delete tag"
					onConfirm={() => remove(deleting)}
				/>
			) : null}
		</Dialog>
	);
}

function RenameRow({
	tag,
	initial,
	disabled,
	onSave,
	onCancel,
}: {
	tag: ChurchTag;
	initial: string;
	disabled: boolean;
	onSave: (name: string) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState(initial);
	const term = value.trim();
	return (
		<form
			className="flex items-center gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				if (term && !disabled) onSave(term);
			}}
		>
			<Input
				aria-label={`New name for ${tag.name}`}
				value={value}
				maxLength={100}
				autoFocus
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onCancel())}
			/>
			<Button type="submit" size="sm" variant="primary" disabled={!term || disabled}>
				Save
			</Button>
			<Button type="button" size="sm" variant="ghost" onClick={onCancel}>
				Cancel
			</Button>
		</form>
	);
}

function ColorMenu({
	tag,
	disabled,
	onColor,
}: {
	tag: ChurchTag;
	disabled: boolean;
	onColor: (color: string | null) => void;
}) {
	const look = tagLook(tag.color);
	const current = tag.color ?? "none";
	const named = (TAG_COLORS as readonly string[]).includes(current) || current === "none";
	const label = tag.color ? ((TAG_COLOR_LABEL as Record<string, string>)[tag.color] ?? "Custom") : "No color";
	return (
		<Menu>
			<MenuTrigger asChild>
				<button
					type="button"
					disabled={disabled}
					aria-label={`Color for ${tag.name}: ${label}`}
					className="grid size-8 flex-none place-items-center rounded-sm transition-[background-color] duration-150 hover:bg-surface-2 disabled:opacity-50"
				>
					<Swatch tone={look.tone} dot={look.dot} />
				</button>
			</MenuTrigger>
			<MenuContent align="start">
				<MenuLabel>Color</MenuLabel>
				<MenuRadioGroup value={named ? current : ""} onValueChange={(v) => onColor(v === "none" ? null : v)}>
					<MenuRadioItem value="none">
						<span className="flex items-center gap-2.5">
							<Swatch />
							No color
						</span>
					</MenuRadioItem>
					{TAG_COLORS.map((c) => (
						<MenuRadioItem key={c} value={c}>
							<span className="flex items-center gap-2.5">
								<Swatch tone={tagLook(c).tone} />
								{TAG_COLOR_LABEL[c]}
							</span>
						</MenuRadioItem>
					))}
				</MenuRadioGroup>
			</MenuContent>
		</Menu>
	);
}

function Swatch({ tone, dot }: { tone?: Tone; dot?: string }) {
	if (dot) return <span aria-hidden="true" className="size-4 rounded-full" style={{ backgroundColor: dot }} />;
	return (
		<span
			aria-hidden="true"
			className={cn(
				"grid size-5 place-items-center rounded-full",
				tone ? TINT[tone] : "shadow-[inset_0_0_0_1.5px_var(--ef-line-2)]",
			)}
		>
			{tone ? <span className="size-2 rounded-full bg-current" /> : null}
		</span>
	);
}
