"use client";

import { BookOpen01Icon, CheckListIcon } from "@hugeicons/core-free-icons";
import { Button, Card, CardTitle, Checkbox, IntentLink, useToast } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { useRef, useState } from "react";
import { answerOffer } from "./actions.ts";
import { loadOffer } from "./fetch.ts";
import {
	CATEGORY_LABEL,
	dayText,
	problemText,
	taskCount,
	type OfferAnswered,
	type OpenOffer,
	type Outcome,
	type PhaseOffer as Offer,
	type TaskItem,
} from "./model.ts";
import { phaseName } from "./Templates.tsx";

// The phase offer (TSK-010, PHASE-006): after a move to a new phase, the Owner or an Admin sees that phase's
// checklists once, with the Wiki's reading for it. Nothing is added until they choose. Accepting adds exactly the
// chosen checklists' tasks, due from the day of the move; a checklist left out or declined is not offered again, and
// Phase checklists can still add it later. One answer counts: a second device shows what was already decided.

type Decided = Extract<Offer, { status: "answered" }>;
const NONE: Offer = { status: "none" };

export function PhaseOffer({
	initial,
	year,
	onAdded,
}: {
	initial: OpenOffer;
	year: number;
	/** The confirmed new tasks, for the list to show without a reload. */
	onAdded: (tasks: TaskItem[]) => void;
}) {
	const toast = useToast();
	// One card at a time: the open offer, what another device decided, or nothing. Close and every answer end it.
	const [card, setCard] = useState<Offer>(initial);
	const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
	const [saving, setSaving] = useState<"accept" | "decline" | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	// One answer intent: a lost reply is sent again with the same key and replays the stored answer.
	const intent = useRef(crypto.randomUUID());

	if (card.status === "answered") return <AlreadyAnswered decided={card} onClose={() => setCard(NONE)} />;
	if (card.status === "none") return null;
	const offer = card;

	async function answer(kind: "accept" | "decline") {
		setSaving(kind);
		setProblem(null);
		const keys = kind === "accept" ? offer.checklists.filter((k) => chosen.has(k.key)).map((k) => k.key) : [];
		const r = await answerOffer(intent.current, {
			transitionId: offer.transition.id,
			catalogVersion: offer.catalogVersion,
			checklistKeys: keys,
		}).catch((): Outcome<OfferAnswered> => ({ status: "lost" }));
		setSaving(null);
		if (r.status === "lost") return setProblem(problemText("lost"));
		intent.current = crypto.randomUUID();
		if (r.status === "ok") {
			onAdded(r.value.created);
			setCard(NONE);
			toast({
				tone: "success",
				message: r.value.created.length
					? `Added ${taskCount(r.value.created.length)} for ${phaseName(offer.transition.toPhase)}.`
					: "Declined. These checklists will not be offered again.",
			});
			return;
		}
		if (r.code === "offer_answered") {
			const read = await loadOffer(offer.transition.id);
			return setCard(read.status === "ok" && read.value.status === "answered" ? read.value : NONE);
		}
		// The phase moved again (conflict): this offer no longer applies.
		const message =
			r.code === "conflict"
				? "The church moved to another phase, so this offer no longer applies."
				: problemText(r.code);
		// The catalog or the phase changed: show the current offer with the reason, or say why the card went away.
		if (r.code === "stale_catalog" || r.code === "conflict") {
			const read = await loadOffer();
			if (read.status === "ok" && read.value.status !== "open") {
				toast({ tone: "error", message });
				return setCard(NONE);
			}
			if (read.status === "ok") {
				setChosen(new Set());
				setCard(read.value);
			}
		}
		setProblem(message);
	}

	const toggle = (key: string) =>
		setChosen((s) => {
			const n = new Set(s);
			if (!n.delete(key)) n.add(key);
			return n;
		});
	const count = offer.checklists.filter((k) => chosen.has(k.key)).reduce((n, k) => n + k.tasks.length, 0);
	const titleId = `phase-offer-${offer.transition.id}`;
	return (
		<Card as="section" aria-labelledby={titleId} className="mb-5 gap-4">
			<div>
				<p className="text-sm text-text-3">Moved on {dayText(offer.transition.anchorDate, year)}</p>
				<CardTitle id={titleId} size="sm" className="mt-1">
					Checklists for {phaseName(offer.transition.toPhase)}
				</CardTitle>
				<p className="mt-1 text-md text-text-2">
					Choose the ones you want. Nothing is added until you do, and tasks are due from the day of the move.
				</p>
			</div>
			<ul aria-label="Offered checklists" className="flex flex-col">
				{offer.checklists.map((k) => (
					<li key={k.key} className="border-t border-line first:border-t-0">
						<Checkbox
							checked={chosen.has(k.key)}
							onCheckedChange={() => toggle(k.key)}
							disabled={saving !== null}
							label={k.name}
							description={`${taskCount(k.tasks.length)} · ${CATEGORY_LABEL[k.category]}. ${k.description}`}
						/>
						<details className="group mb-3 ml-8">
							<summary className="cursor-pointer text-sm text-text-2 underline-offset-[3px] hover:underline">
								Show the {taskCount(k.tasks.length)}
							</summary>
							<ol className="mt-2 flex flex-col gap-1.5">
								{k.tasks.map((t) => (
									<li key={t.key} className="flex flex-wrap justify-between gap-x-3 text-sm">
										<span className="text-ink">{t.title}</span>
										<span className="whitespace-nowrap text-text-3">Due {dayText(t.due, year)}</span>
									</li>
								))}
							</ol>
						</details>
					</li>
				))}
			</ul>
			{offer.recommendations.length ? (
				<div>
					<p className="flex items-center gap-2 text-sm font-medium text-ink">
						<Icon icon={BookOpen01Icon} size={16} className="text-text-3" />
						Read for this phase
					</p>
					<ul className="mt-1.5 flex flex-col gap-1">
						{offer.recommendations.map((a) => (
							<li key={a.slug}>
								<IntentLink
									href={`/wiki/${a.slug}`}
									className="cursor-pointer text-sm text-ink underline decoration-green-500 decoration-2 underline-offset-[3px]"
								>
									{a.title}
								</IntentLink>
							</li>
						))}
					</ul>
				</div>
			) : null}
			{problem ? (
				<p role="alert" className="rounded-md bg-surface px-4 py-2.5 text-sm text-ink">
					{problem}
				</p>
			) : null}
			<div className="flex flex-wrap items-center gap-2.5">
				<Button
					variant="primary"
					icon={CheckListIcon}
					disabled={chosen.size === 0 || saving === "decline"}
					loading={saving === "accept"}
					onClick={() => void answer("accept")}
				>
					{chosen.size ? `Add ${taskCount(count)}` : "Choose a checklist"}
				</Button>
				<Button
					variant="ghost"
					disabled={saving === "accept"}
					loading={saving === "decline"}
					onClick={() => void answer("decline")}
				>
					Decline all
				</Button>
				<span className="text-sm text-text-3">
					Checklists you leave out are not offered again. You can still add them from Phase checklists.
				</span>
			</div>
		</Card>
	);
}

/** Another device or person answered first: what they decided, read from the database. */
function AlreadyAnswered({ decided, onClose }: { decided: Decided; onClose: () => void }) {
	const a = decided.answer;
	return (
		<Card as="section" aria-label="Phase offer already answered" className="mb-5 gap-3" role="status">
			<CardTitle size="sm">This offer was already answered</CardTitle>
			<p className="text-md text-text-2">
				{a.answer === "accepted"
					? `Someone accepted it on another device or seat. Added ${taskCount(a.tasks.length)}:`
					: "Someone declined every checklist on another device or seat. No tasks were added."}
			</p>
			{a.tasks.length ? (
				<ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink marker:text-text-3">
					{a.tasks.map((t) => (
						<li key={t.id}>{t.title}</li>
					))}
				</ul>
			) : null}
			<div>
				<Button variant="secondary" size="sm" onClick={onClose}>
					Close
				</Button>
			</div>
		</Card>
	);
}
