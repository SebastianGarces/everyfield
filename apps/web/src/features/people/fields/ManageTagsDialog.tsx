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
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import type { Outcome } from "../../../components/save/model.ts";
import { DialogNotice, type SaveIntent } from "../../../components/save/parts.tsx";
import { FormProblem, problemText } from "../parts.tsx";
import { createChurchTag, deleteChurchTag, listChurchTags, updateChurchTag } from "./actions.ts";
import { TAG_COLOR_LABEL, TAG_COLORS, tagLook, type ChurchTag } from "./model.ts";

const byName = (a: { name: string }, b: { name: string }) =>
	a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
const problem = (r: Outcome<unknown>) => (r.status === "ok" ? undefined : r.status === "lost" ? "lost" : r.code);
/** The words for a tag write that was refused: a rename onto an existing name is a conflict (REQ-PPL-010). */
export const tagProblem = (code: string) =>
	code === "conflict"
		? "Another tag already has this name, or the tag changed. Check the list and try again."
		: problemText(code);

/**
 * Church tags (REQ-PPL-010): create, rename, recolor and delete the church's own tags. A change shows on every person
 * who has the tag. Delete says how many people have it first; their history keeps the tag. Changes save through the tags
 * card's lane, so the card and this dialog save one change at a time and its notice shows here while the dialog is open.
 */
export function ManageTagsDialog({
	open,
	lane,
	onOpenChange,
	onChurchTags,
}: {
	open: boolean;
	lane: SaveIntent<{ problem?: string }>;
	onOpenChange: (open: boolean) => void;
	/** Every change to the church's tags, so chips on the page follow it. */
	onChurchTags: (tags: ChurchTag[]) => void;
}) {
	// Read fresh on every opening: the counts change whenever anyone tags a person.
	const [loaded, setLoaded] = useState<Outcome<ChurchTag[]> | null>(null);
	const tags = loaded?.status === "ok" ? loaded.value : [];
	// Create, rename, recolor and delete show at once; a refused change falls back to the saved list with its reason.
	const [shown, apply] = useOptimistic(tags, (all, change: { put: ChurchTag } | { remove: string }) =>
		"put" in change
			? [...all.filter((t) => t.id !== change.put.id), change.put].sort(byName)
			: all.filter((t) => t.id !== change.remove),
	);
	const [, start] = useTransition();
	const [name, setName] = useState("");
	/** A delete whose fresh read of the tags failed: nothing was sent. */
	const [rowProblem, setRowProblem] = useState<{ id: string; text: string } | null>(null);
	const wait = lane.wait;
	const [renaming, setRenaming] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<ChurchTag | null>(null);
	// The list as last saved. Saves that finish out of order each start from it, so none brings back an older tag.
	const latest = useRef<ChurchTag[]>([]);

	useEffect(() => {
		if (loaded) return;
		let live = true;
		listChurchTags()
			.catch(() => ({ status: "lost" }) as const)
			.then((r) => {
				if (!live) return;
				if (r.status === "ok") latest.current = r.value;
				setLoaded(r);
			});
		return () => {
			live = false;
		};
	}, [loaded]);

	const save = (update: (all: ChurchTag[]) => ChurchTag[]) => {
		const all = update(latest.current).sort(byName);
		latest.current = all;
		setLoaded({ status: "ok", value: all });
		onChurchTags(all);
	};

	/**
	 * Delete starts from the church's tags read now, so the confirmation names how many people have the tag at this
	 * moment and the delete sends the tag's current revision (REQ-PPL-010: deletion previews the linked count).
	 */
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
				// The typed name comes back so a retry needs no retyping.
				refused: () => setName((now) => now || term),
				ok: (tag) => save((all) => [...all.filter((t) => t.id !== tag.id), tag]),
			});
		});
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
									{renaming === t.id ? (
										<RenameRow
											tag={t}
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
														<MenuItem icon={Edit02Icon} disabled={wait !== null} onSelect={() => setRenaming(t.id)}>
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
	disabled,
	onSave,
	onCancel,
}: {
	tag: ChurchTag;
	/** The card's last save is in flight or unknown (C68). */
	disabled: boolean;
	onSave: (name: string) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState(tag.name);
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

/** The tag's color as a swatch button; its menu offers no color and one color per brand tone. */
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
					className="grid size-8 flex-none cursor-pointer place-items-center rounded-sm transition-[background-color] duration-150 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
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

/** A color sample: the tone's tint with its mark color in the middle, or the exact hex, or an empty ring. */
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
