"use client";

import { Add01Icon, Cancel01Icon, Settings01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button, Input, Popover, PopoverContent, PopoverTrigger, Spinner, useToast } from "@everyfield/ui/controls";
import { Tag } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useOptimistic, useRef, useState, useTransition, type KeyboardEvent } from "react";
import type { Receipt } from "../boundary.ts";
import type { Outcome } from "../model.ts";
import { fresh, PersonLink, problemText } from "../parts.tsx";
import { addPersonTag, listChurchTags, removePersonTag } from "./actions.ts";
import { ManageTagsDialog } from "./ManageTagsDialog.tsx";
import { tagLook, type ChurchTag, type PersonTag } from "./model.ts";

type Change = { add: PersonTag } | { remove: string };
const byName = (a: { name: string }, b: { name: string }) =>
	a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/**
 * A person's tags (REQ-PPL-010), at the foot of Details as in the prototype. Each tag opens People filtered by it.
 * Owners and Admins add a church tag or a new one from the picker and remove one with its x. The chip shows at once and
 * rolls back with a message when the server refuses. A repeated add or remove changes nothing and adds no Activity.
 */
export function TagsField({
	personId,
	personName,
	initial,
	canEdit,
	onSaved,
}: {
	personId: string;
	personName: string;
	/** Null when the tags did not load. */
	initial: PersonTag[] | null;
	canEdit: boolean;
	onSaved: (receipt: Receipt) => void;
}) {
	const toast = useToast();
	const [tags, setTags] = useState<PersonTag[]>(initial ?? []);
	const [shown, apply] = useOptimistic(tags, (current, change: Change) =>
		"add" in change
			? [...current.filter((t) => t.id !== change.add.id), change.add].sort(byName)
			: current.filter((t) => t.id !== change.remove),
	);
	const [, start] = useTransition();
	const [church, setChurch] = useState<Outcome<ChurchTag[]> | null>(null);
	const [open, setOpen] = useState(false);
	const [managing, setManaging] = useState(false);
	const loading = useRef(false);

	/**
	 * Reads the church's tags each time the picker opens, so names and counts are current; the last list stays on screen
	 * while the new one arrives. Focus that returns to Add tag after the picker or the manager closes reads nothing.
	 */
	function warm() {
		if (loading.current) return;
		loading.current = true;
		listChurchTags()
			.catch(() => ({ status: "lost" }) as const)
			.then((r) => {
				loading.current = false;
				setChurch(r);
			});
	}
	/** This person's saved change moves the tag's count in the open picker by one. */
	const count = (tagId: string, by: 1 | -1) =>
		setChurch((c) =>
			c?.status === "ok"
				? {
						...c,
						value: c.value.map((t) => (t.id === tagId ? { ...t, linkedPeople: Math.max(0, t.linkedPeople + by) } : t)),
					}
				: c,
		);
	const fail = (what: string, r: Outcome<unknown>) =>
		toast({ tone: "error", message: `${what} ${problemText(r.status === "refused" ? r.code : "lost")}` });

	function add(tag: { id: string; name: string; color: string | null } | { name: string }) {
		const optimistic = "id" in tag ? tag : { id: `new:${tag.name}`, name: tag.name, color: null };
		start(async () => {
			apply({ add: optimistic as PersonTag });
			const r = await addPersonTag(
				fresh(),
				"id" in tag ? { personId, tagId: tag.id } : { personId, name: tag.name },
			).catch(() => ({ status: "lost" }) as const);
			if (r.status !== "ok") return fail(`${tag.name} was not added.`, r);
			setTags(r.value.tags);
			const created = r.value.created;
			if (created) setChurch((c) => (c?.status === "ok" ? { ...c, value: [...c.value, created].sort(byName) } : c));
			if (r.value.receipt.changed) count(created?.id ?? ("id" in tag ? tag.id : ""), 1);
			onSaved(r.value.receipt);
		});
	}
	function remove(tag: PersonTag) {
		start(async () => {
			apply({ remove: tag.id });
			const r = await removePersonTag(fresh(), { personId, tagId: tag.id }).catch(() => ({ status: "lost" }) as const);
			if (r.status !== "ok") return fail(`${tag.name} was not removed.`, r);
			setTags(r.value.tags);
			if (r.value.receipt.changed) count(tag.id, -1);
			onSaved(r.value.receipt);
		});
	}

	if (initial === null)
		return <p className="mt-4 text-sm text-text-3">Tags did not load. Reload the page to see them.</p>;
	if (!canEdit && shown.length === 0) return null;

	return (
		<div className="mt-4 flex flex-wrap items-center gap-2" aria-label={`Tags for ${personName}`} role="group">
			{shown.map((t) => (
				<TagChip key={t.id} tag={t} onRemove={canEdit ? () => remove(t) : undefined} />
			))}
			{canEdit ? (
				<Popover
					open={open}
					onOpenChange={(next) => {
						setOpen(next);
						if (next) warm();
					}}
				>
					<PopoverTrigger asChild>
						<Button variant="ghost" size="sm" icon={Add01Icon} className="h-[26px] px-2 text-text-2">
							Add tag
						</Button>
					</PopoverTrigger>
					<PopoverContent label="Tags" align="start" className="w-[300px] p-0">
						<TagPicker
							church={church}
							chosen={shown}
							onRetry={() => {
								setChurch(null);
								warm();
							}}
							onToggle={(t) => (shown.some((s) => s.id === t.id) ? remove(t) : add(t))}
							onCreate={(name) => add({ name })}
							onManage={() => {
								setOpen(false);
								setManaging(true);
							}}
						/>
					</PopoverContent>
				</Popover>
			) : null}
			{managing ? (
				<ManageTagsDialog
					open
					onOpenChange={setManaging}
					onChurchTags={(all) => {
						setChurch({ status: "ok", value: all });
						// A rename, recolor or delete shows on this person's chips at once.
						setTags((mine) =>
							mine.flatMap((t) => {
								const now = all.find((a) => a.id === t.id);
								return now ? [{ id: now.id, name: now.name, color: now.color }] : [];
							}),
						);
					}}
				/>
			) : null}
		</div>
	);
}

/**
 * One tag as a chip: its color, a link to People filtered by it (prefetched on intent, like person links) and, for
 * editors, a 24 px remove button.
 */
export function TagChip({ tag, onRemove }: { tag: PersonTag; onRemove?: () => void }) {
	const look = tagLook(tag.color);
	const pending = tag.id.startsWith("new:");
	return (
		<Tag tone={look.tone} className={cn("max-w-full gap-0 px-0", pending && "opacity-60")}>
			{pending ? (
				<span className="flex min-w-0 items-center gap-1.5 px-2.5">
					<span className="truncate">{tag.name}</span>
				</span>
			) : (
				<PersonLink
					href={`/people?tag=${tag.id}`}
					className={cn("flex h-full min-w-0 items-center gap-1.5 rounded-md px-2.5", onRemove && "pr-1")}
				>
					{look.dot ? (
						<span aria-hidden="true" className="size-2 flex-none rounded-full" style={{ backgroundColor: look.dot }} />
					) : null}
					<span className="truncate">{tag.name}</span>
				</PersonLink>
			)}
			{onRemove && !pending ? (
				<button
					type="button"
					onClick={onRemove}
					aria-label={`Remove tag ${tag.name}`}
					className="mr-0.5 grid size-6 flex-none cursor-pointer place-items-center rounded-sm opacity-70 transition-[opacity,background-color] duration-150 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
				>
					<Icon icon={Cancel01Icon} size={16} />
				</button>
			) : null}
		</Tag>
	);
}

/**
 * The tag picker: search the church's tags, toggle one on or off, or create the typed name. Arrow keys move between
 * options; Enter in the search box picks the only match or creates the name.
 */
function TagPicker({
	church,
	chosen,
	onToggle,
	onCreate,
	onManage,
	onRetry,
}: {
	church: Outcome<ChurchTag[]> | null;
	chosen: PersonTag[];
	onToggle: (tag: PersonTag) => void;
	onCreate: (name: string) => void;
	onManage: () => void;
	onRetry: () => void;
}) {
	const [query, setQuery] = useState("");
	const list = useRef<HTMLUListElement>(null);
	const term = query.trim();
	const all = church?.status === "ok" ? church.value : [];
	const matches = all.filter((t) => t.name.toLowerCase().includes(term.toLowerCase()));
	const exact = all.some((t) => t.name.trim().toLowerCase() === term.toLowerCase());
	// The server matches names by case and outer spaces, so a name typed before the list arrives is still safe to create.
	const canCreate = term.length > 0 && term.length <= 100 && !exact;

	const options = () => [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-option]") ?? [])];
	function move(e: KeyboardEvent, from: number) {
		const all = options();
		const next = e.key === "ArrowDown" ? from + 1 : e.key === "ArrowUp" ? from - 1 : null;
		if (next === null) return;
		e.preventDefault();
		all[Math.max(0, Math.min(all.length - 1, next))]?.focus();
	}
	function enter(e: KeyboardEvent) {
		if (e.key === "ArrowDown") return move(e, -1);
		if (e.key !== "Enter") return;
		e.preventDefault();
		if (matches.length === 1) onToggle(matches[0]!);
		else if (canCreate) {
			onCreate(term);
			setQuery("");
		}
	}

	return (
		<div className="flex flex-col">
			<div className="border-b border-line p-2">
				<Input
					aria-label="Find or create a tag"
					placeholder="Find or create a tag"
					value={query}
					maxLength={100}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={enter}
					autoFocus
				/>
			</div>
			<ul ref={list} className="max-h-[260px] overflow-y-auto p-1.5" aria-label="Church tags">
				{church === null ? (
					<li className="flex items-center gap-2.5 px-2.5 py-3 text-sm text-text-3" role="status">
						<Spinner size={16} />
						Loading tags…
					</li>
				) : church.status !== "ok" ? (
					<li role="alert" className="flex flex-col items-start gap-2 px-2.5 py-3 text-sm text-text-2">
						<span>The church&apos;s tags did not load.</span>
						<button
							type="button"
							onClick={onRetry}
							className="cursor-pointer font-medium text-ink underline underline-offset-[3px]"
						>
							Try again
						</button>
					</li>
				) : (
					<>
						{matches.map((t, i) => {
							const on = chosen.some((c) => c.id === t.id);
							const look = tagLook(t.color);
							return (
								<li key={t.id}>
									<button
										type="button"
										data-option=""
										aria-pressed={on}
										onClick={() => onToggle({ id: t.id, name: t.name, color: t.color })}
										onKeyDown={(e) => move(e, i)}
										className="flex min-h-[38px] w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-md text-ink transition-[background-color] duration-150 hover:bg-surface-2"
									>
										<span
											aria-hidden="true"
											className={cn(
												"grid size-[18px] flex-none place-items-center rounded-xs",
												on ? "bg-ink text-on-ink" : "shadow-[inset_0_0_0_1.5px_var(--ef-text-3)]",
											)}
										>
											{on ? <Icon icon={Tick02Icon} size={16} /> : null}
										</span>
										<Tag tone={look.tone} className="min-w-0">
											{look.dot ? (
												<span
													aria-hidden="true"
													className="size-2 rounded-full"
													style={{ backgroundColor: look.dot }}
												/>
											) : null}
											<span className="truncate">{t.name}</span>
										</Tag>
										<span className="ml-auto text-xs text-text-3 tabular-nums">
											<span className="sr-only">, </span>
											{t.linkedPeople}
											<span className="sr-only"> {t.linkedPeople === 1 ? "person" : "people"}</span>
										</span>
									</button>
								</li>
							);
						})}
						{matches.length === 0 && !canCreate ? (
							<li className="px-2.5 py-3 text-sm text-text-3">
								{all.length === 0 ? "No tags yet. Type a name to create one." : "No matches"}
							</li>
						) : null}
					</>
				)}
				{canCreate ? (
					<li>
						<button
							type="button"
							data-option=""
							onClick={() => {
								onCreate(term);
								setQuery("");
							}}
							onKeyDown={(e) => move(e, matches.length)}
							className="flex min-h-[38px] w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-md text-ink transition-[background-color] duration-150 hover:bg-surface-2"
						>
							<Icon icon={Add01Icon} size={18} className="text-text-2" />
							<span className="min-w-0 truncate">
								Create tag <span className="font-medium">“{term}”</span>
							</span>
						</button>
					</li>
				) : null}
			</ul>
			<div className="border-t border-line p-1.5">
				<button
					type="button"
					onClick={onManage}
					className="flex min-h-[38px] w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-text-2 transition-[background-color] duration-150 hover:bg-surface-2"
				>
					<Icon icon={Settings01Icon} size={18} />
					Manage church tags
				</button>
			</div>
		</div>
	);
}
