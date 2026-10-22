"use client";

import { Package01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardScrollArea,
	CardTitle,
	Checkbox,
	EmptyState,
	useToast,
} from "@everyfield/ui/controls";
import { useOptimistic, useTransition } from "react";
import { populateKit, updateKitItem } from "./actions.ts";
import { KIT_CATEGORY_LABEL, problemText, type Detail, type KitItem } from "./model.ts";
import { RowNotices, SaveNotice, useRowLanes, useSaveIntent } from "../../components/save/parts.tsx";

export type Kit = { version: number | null; items: KitItem[] };

/**
 * The Vision kit (REQ-MTG-006). A tick shows at once and is confirmed by the answer, or put back with the reason. A
 * meeting without a kit offers to add the reviewed one; reading never adds it.
 */
export function KitCard({
	meeting,
	kit,
	canWrite,
	onKit,
	onMeeting,
	onStale,
}: {
	meeting: Detail;
	kit: Kit | null;
	canWrite: boolean;
	onKit: (kit: Kit) => void;
	onMeeting: (meeting: Detail) => void;
	/** A save was refused as out of date: read the meeting again. */
	onStale: () => void;
}) {
	const toast = useToast();
	const [, startTransition] = useTransition();
	const [items, tick] = useOptimistic(kit?.items ?? [], (all: KitItem[], change: { id: string; checked: boolean }) =>
		all.map((k) => (k.id === change.id ? { ...k, checked: change.checked } : k)),
	);
	// Ticks save side by side, one save per item at a time (a second tick waits for the first answer and its new
	// revision); adding the kit has the card's own lane (components/save).
	const ticks = useRowLanes(problemText);
	const adding = useSaveIntent({ explain: problemText });
	const checked = items.filter((k) => k.checked).length;

	function toggle(item: KitItem, on: boolean) {
		if (ticks.stateOf(item.id)) return;
		startTransition(async () => {
			tick({ id: item.id, checked: on });
			await ticks.save(item.id, {
				what: item.text,
				done: on ? "ticked" : "unticked",
				send: (key) => updateKitItem(key, item.revision, meeting.id, item.id, { checked: on }),
				ok: (value) => startTransition(() => onKit({ version: kit?.version ?? null, items: value.items })),
				refused: (code) => {
					toast({ message: `${item.text} was not ${on ? "ticked" : "unticked"}. ${problemText(code)}`, tone: "error" });
					if (code === "conflict") onStale();
				},
			});
		});
	}
	function populate() {
		void adding.save({
			what: "The Vision kit",
			done: "added",
			send: (key) => populateKit(key, meeting.revision, meeting.id),
			ok: (value) => {
				onMeeting(value.meeting);
				onKit({ version: value.kit.version, items: value.kit.items });
			},
			refused: (code) => code === "conflict" && onStale(),
		});
	}

	if (!kit || kit.version === null)
		return (
			<Card as="section" aria-labelledby="kit-title">
				<CardHeader>
					<CardHeading>
						<CardTitle id="kit-title">Vision kit</CardTitle>
						<CardDescription>Not added yet</CardDescription>
					</CardHeading>
				</CardHeader>
				<SaveNotice {...adding.noticeProps} dialogOpen={false} />
				<EmptyState
					icon={Package01Icon}
					title="No kit for this meeting"
					headingLevel="h3"
					action={
						canWrite ? (
							<Button
								variant="secondary"
								size="sm"
								loading={adding.saving}
								disabled={adding.wait !== null}
								onClick={populate}
							>
								Add the Vision kit
							</Button>
						) : null
					}
				>
					The reviewed checklist: sign-in sheets, response cards, banners, cables and the rest.
				</EmptyState>
			</Card>
		);

	const groups = Object.entries(KIT_CATEGORY_LABEL)
		.map(([category, label]) => ({ label, items: items.filter((k) => k.category === category) }))
		.filter((g) => g.items.length > 0);
	return (
		<Card as="section" aria-labelledby="kit-title">
			<CardHeader className="mb-3">
				<CardHeading>
					<CardTitle id="kit-title">Vision kit</CardTitle>
					<CardDescription>
						{checked} of {items.length} ready
					</CardDescription>
				</CardHeading>
				<KitRing done={checked} total={items.length} />
			</CardHeader>
			<RowNotices lanes={ticks} className="mb-3" />
			<CardScrollArea label="Vision kit items" maxHeight={300}>
				{groups.map((g) => (
					<fieldset key={g.label} className="mt-3 first:mt-0">
						<legend className="mb-0.5 text-xs font-semibold tracking-[0.04em] text-text-3 uppercase">{g.label}</legend>
						{g.items.map((k) => (
							<Checkbox
								key={k.id}
								shape="round"
								className="py-2"
								label={<span className={k.checked ? "text-text-3 line-through" : undefined}>{k.text}</span>}
								description={k.assignee ? k.assignee.displayName : undefined}
								checked={k.checked}
								disabled={!canWrite || ticks.stateOf(k.id) !== undefined}
								onCheckedChange={(on) => toggle(k, on === true)}
							/>
						))}
					</fieldset>
				))}
			</CardScrollArea>
		</Card>
	);
}

/** A small progress ring. The numbers are in the card description, so the ring is decoration. */
function KitRing({ done, total }: { done: number; total: number }) {
	const r = 18;
	const c = 2 * Math.PI * r;
	const share = total ? done / total : 0;
	return (
		<svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true" className="flex-none -rotate-90">
			<circle cx="22" cy="22" r={r} fill="none" strokeWidth="5" className="stroke-surface-3" />
			<circle
				cx="22"
				cy="22"
				r={r}
				fill="none"
				strokeWidth="5"
				strokeLinecap="round"
				strokeDasharray={`${c * share} ${c}`}
				className="stroke-green-500 transition-[stroke-dasharray] duration-300 motion-reduce:transition-none"
			/>
		</svg>
	);
}
