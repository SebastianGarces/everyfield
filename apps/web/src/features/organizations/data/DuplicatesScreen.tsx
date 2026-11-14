"use client";

import type { mergeResult, mergeReview, organizationDuplicatePairs } from "@everyfield/contracts/people";
import { Tick02Icon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import {
	Button,
	CalloutLabel,
	CalloutText,
	Card,
	CardBody,
	EmptyState,
	PageHeader,
	Radio,
	RadioGroup,
} from "@everyfield/ui/controls";
import Link from "next/link";
import { useState } from "react";
import type { z } from "zod";
import { blockerText, counted, FIELD_LABEL, fieldText, type Columns } from "../../people/corrections/model";
import { PIPELINE_PATH } from "../board/model";
import { Problem } from "../board/Problem";
import { mergePeople, reviewMerge, undoMerge } from "./actions";

// Possible duplicates for the organization pipeline (REQ-MUL-017), in the planter duplicates review's shape. A pair is
// a suggestion: opening it changes nothing, and the merge waits until the Owner or Admin picks the record that stays and
// the value to keep for every field that differs. A merge can be undone while nothing has changed since. A merged pair
// keeps its card, with the result and the undo, until the page is read again.

type Pairs = z.infer<typeof organizationDuplicatePairs>;
type Pair = Pairs["items"][number];
type Review = z.infer<typeof mergeReview>;
type Merged = z.infer<typeof mergeResult>;
type Side = "source" | "survivor";
type Answer = { status: string; error?: { code: string; details?: unknown } };

const SHARED: Record<Pair["shared"][number], string> = { email: "Same email", phone: "Same phone" };

function problemText(answer: Answer) {
	if (answer.status === "lost") return "We couldn’t reach Everyfield. Nothing changed. Try again.";
	switch (answer.error?.code) {
		case "conflict":
			return "One of these records changed while you were reviewing. Review the pair again.";
		case "inverse_conflict":
			return "Something changed after the merge, so it can’t be undone exactly. Nothing changed.";
		default:
			return "You don’t have access to make this change.";
	}
}

export function DuplicatesScreen({ pairs }: { pairs: Pairs }) {
	const [open, setOpen] = useState<string | null>(null);
	const key = (p: Pair) => `${p.person.id}:${p.with.id}`;
	return (
		<div className="flex min-w-0 flex-col gap-5">
			<PageHeader
				breadcrumb={[{ label: "Pipeline", href: PIPELINE_PATH }, { label: "Possible duplicates" }]}
				title="Possible duplicates"
				subtitle="People in your pipeline who share an email or phone. These are suggestions: nothing merges until you choose."
			/>
			{pairs.items.length === 0 ? (
				<EmptyState icon={UserMultipleIcon} title="No possible duplicates">
					No two people in your pipeline share an email or phone.
				</EmptyState>
			) : (
				<ul className="flex flex-col gap-3">
					{pairs.items.map((p) => (
						<li key={key(p)}>
							<PairCard pair={p} open={open === key(p)} onOpen={() => setOpen(open === key(p) ? null : key(p))} />
						</li>
					))}
				</ul>
			)}
			{pairs.completeness === "partial" ? (
				<p className="text-sm text-text-2">Showing the first 100 pairs. Merge or update some to see the rest.</p>
			) : null}
		</div>
	);
}

function PairCard({ pair, open, onOpen }: { pair: Pair; open: boolean; onOpen: () => void }) {
	const names = [pair.person.displayName, pair.with.displayName];
	return (
		<Card>
			<CardBody className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="min-w-0">
						<p className="text-md font-medium text-ink text-pretty">
							{names[0]} <span className="text-text-3">and</span> {names[1]}
						</p>
						<p className="mt-0.5 text-sm text-text-2">{pair.shared.map((s) => SHARED[s]).join(" · ")}</p>
					</div>
					<Button variant={open ? "ghost" : "secondary"} onClick={onOpen} aria-expanded={open}>
						{open ? "Close" : "Review"}
					</Button>
				</div>
				{open ? <MergeReview pair={pair} /> : null}
			</CardBody>
		</Card>
	);
}

/** Pick the record that stays, then a value for each differing field; then merge, and undo while nothing changed. */
function MergeReview({ pair }: { pair: Pair }) {
	const people = [pair.person, pair.with];
	const [keep, setKeep] = useState<string | null>(null);
	const [review, setReview] = useState<Review | null>(null);
	const [choices, setChoices] = useState<Record<string, Side>>({});
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [merged, setMerged] = useState<Merged | null>(null);
	const [undone, setUndone] = useState(false);

	const choose = async (survivorId: string) => {
		setKeep(survivorId);
		setReview(null);
		setChoices({});
		setProblem(null);
		const sourceId = people.find((p) => p.id !== survivorId)!.id;
		const answer = await reviewMerge({ sourceId, survivorId }).catch(() => ({ status: "lost" }) as const);
		if (answer.status === "ok") setReview(answer.value);
		else setProblem(problemText(answer));
	};

	if (merged) {
		const survivor = people.find((p) => p.id === merged.survivorId)!.displayName;
		const source = people.find((p) => p.id === merged.sourceId)!.displayName;
		if (undone)
			return (
				<Card variant="callout" tone="green">
					<CalloutLabel tone="green" icon={Tick02Icon}>
						Merge undone
					</CalloutLabel>
					<CalloutText>
						{survivor} and {source} are back as two records, exactly as they were.
					</CalloutText>
				</Card>
			);
		return (
			<div className="flex flex-col gap-3">
				<Card variant="callout" tone="green">
					<CalloutLabel tone="green" icon={Tick02Icon}>
						Merged
					</CalloutLabel>
					<CalloutText>
						{source} is now part of {survivor}: their stage history, enrollments and conversations are on one record.
					</CalloutText>
				</Card>
				<Problem text={problem} />
				<div className="flex flex-wrap gap-2">
					<Button variant="primary" asChild>
						<Link href={`${PIPELINE_PATH}/${merged.survivorId}`}>Open {survivor}</Link>
					</Button>
					<Button
						variant="secondary"
						loading={busy}
						onClick={async () => {
							setBusy(true);
							setProblem(null);
							const answer = await undoMerge(crypto.randomUUID(), merged.mergeId).catch(
								() => ({ status: "lost" }) as const,
							);
							setBusy(false);
							if (answer.status === "ok") setUndone(true);
							else setProblem(problemText(answer));
						}}
					>
						Undo merge
					</Button>
				</div>
			</div>
		);
	}

	const name = (side: Side) => (review ? review[side].displayName : "");
	const blocked = review ? review.blockers.causes.length > 0 : false;
	const ready = review !== null && !blocked && review.fields.every((f) => choices[f.field]);
	const merge = async () => {
		if (!review) return;
		setBusy(true);
		setProblem(null);
		const answer = await mergePeople({
			requestKey: crypto.randomUUID(),
			input: {
				sourceId: review.source.personId,
				survivorId: review.survivor.personId,
				reviewDigest: review.reviewDigest,
				fieldChoices: choices,
			},
		}).catch(() => ({ status: "lost" }) as const);
		setBusy(false);
		if (answer.status === "ok") setMerged(answer.value);
		else if (answer.status === "refused" && answer.error.code === "merge_blocked") void choose(keep!);
		else setProblem(problemText(answer));
	};

	return (
		<div className="flex max-w-[720px] flex-col gap-5 border-t border-line pt-4">
			<fieldset>
				<legend className="text-sm font-medium text-ink">Which record stays?</legend>
				<p className="mt-0.5 text-sm text-text-2">The other one becomes part of it.</p>
				<RadioGroup
					className="mt-1"
					value={keep ?? ""}
					onValueChange={(v) => void choose(v)}
					aria-label="Record that stays"
				>
					{people.map((p) => (
						<Radio key={p.id} value={p.id} label={p.displayName} />
					))}
				</RadioGroup>
			</fieldset>
			{review && blocked ? (
				<div role="alert" className="rounded-md bg-magenta-50 px-3 py-2.5 text-sm text-magenta-600">
					<p className="font-medium">These records can’t be merged</p>
					<ul className="mt-1 flex flex-col gap-1">
						{review.blockers.causes.map((cause) => (
							<li key={cause}>
								{blockerText(cause, { source: name("source"), survivor: name("survivor") }, review.blockers.references)}
							</li>
						))}
					</ul>
					<p className="mt-1.5">Nothing changed.</p>
				</div>
			) : null}
			{review && !blocked ? (
				<>
					{review.fields.length ? (
						<div className="flex flex-col gap-4">
							<p className="text-sm font-medium text-ink">Choose the value to keep</p>
							{review.fields.map((f) => (
								<fieldset key={f.field}>
									<legend className="text-sm text-text-2">{FIELD_LABEL[f.field]}</legend>
									<RadioGroup
										value={choices[f.field] ?? ""}
										onValueChange={(v) => setChoices((c) => ({ ...c, [f.field]: v as Side }))}
										aria-label={FIELD_LABEL[f.field]}
									>
										{(["survivor", "source"] as const).map((side) => (
											<Radio
												key={side}
												value={side}
												label={fieldText(f.field, f[side] as Columns) ?? "None"}
												description={`From ${name(side)}`}
											/>
										))}
									</RadioGroup>
								</fieldset>
							))}
						</div>
					) : (
						<p className="text-sm text-text-2">Every field is the same on both records.</p>
					)}
					{review.references.length ? (
						<p className="text-sm text-text-2 text-pretty">
							Moves to {name("survivor")}:{" "}
							{review.references
								.filter((r) => r.treatment !== "keep")
								.map((r) => counted(r.kind, r.count))
								.join(", ") || "nothing else"}
							. {name("source")}’s stage history and conversations show on {name("survivor")}’s record.
						</p>
					) : null}
					<Problem text={problem} />
					<div>
						<Button variant="primary" disabled={!ready} loading={busy} onClick={merge}>
							Merge into {name("survivor")}
						</Button>
					</div>
				</>
			) : (
				<Problem text={problem} />
			)}
		</div>
	);
}
