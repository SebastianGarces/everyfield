"use client";

import { UserMultiple02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	buttonVariants,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	EmptyState,
	IntentLink,
} from "@everyfield/ui/controls";
import { Avatar } from "@everyfield/ui/display";
import { useState, type ReactNode } from "react";
import { sendTwice, type Outcome } from "../../../components/save/model.ts";
import { dismissPair, restorePair, type PairChange } from "./actions.ts";
import {
	pairAnswered,
	pairKey,
	pairSent,
	pairsAtStart,
	pairsShown,
	pairHref,
	type PairAction,
	type PairState,
} from "./model.ts";
import { Problem } from "./parts.tsx";
import type { DismissedPairs as Dismissed, DuplicatePairs as Pairs } from "./server.ts";

type Pair = { person: { id: string; displayName: string }; with: { id: string; displayName: string } };
const send: Record<PairAction, (input: unknown) => Promise<Outcome<PairChange>>> = {
	dismiss: dismissPair,
	restore: restorePair,
};

/**
 * One list's dismiss or restore (D-789). The row leaves at once; a refused or lost answer puts it back in its place with
 * a notice. The write sets a state, so a lost answer is sent once more as it is.
 */
function usePairs<P extends Pair>(items: readonly P[], action: PairAction) {
	const [state, setState] = useState<PairState>(pairsAtStart);
	const [said, setSaid] = useState("");
	const run = async (p: P) => {
		const key = pairKey(p);
		setState((s) => pairSent(s, key));
		const answer = await sendTwice(() => send[action]({ personId: p.person.id, withPersonId: p.with.id }));
		setState((s) => pairAnswered(s, key, action, answer));
		if (answer.status === "ok")
			setSaid(
				action === "dismiss"
					? `${p.person.displayName} and ${p.with.displayName} marked not a duplicate.`
					: `${p.person.displayName} and ${p.with.displayName} are back on the list.`,
			);
	};
	return { shown: pairsShown(items, state), notice: (p: P) => state.notices[pairKey(p)], run, said };
}

/**
 * The pairs to review at /people/duplicates (REQ-PPL-018): each person a CSV import added with "Add, review later" and
 * the person they may duplicate. Review opens the side-by-side review; "Not a duplicate" takes the pair off the list.
 * A pair also leaves once either person is merged or retired. With none, a plain empty state.
 */
export function DuplicatePairs({ pairs }: { pairs: Pairs }) {
	const { shown, notice, run, said } = usePairs(pairs.items, "dismiss");
	const count = shown.length;
	return (
		<>
			<Said text={said} />
			{!count ? (
				<Card>
					<EmptyState
						icon={UserMultiple02Icon}
						title="Nothing to review"
						headingLevel="h2"
						action={
							<IntentLink href="/people" className={buttonVariants({ variant: "primary" })}>
								Back to People
							</IntentLink>
						}
					>
						People an import added with &ldquo;Add, review later&rdquo; show here until you merge them, retire one or mark
						them not a duplicate.
					</EmptyState>
				</Card>
			) : (
				<Card as="section" aria-labelledby="pairs-title">
					<CardHeader className="mb-1">
						<CardHeading>
							<CardTitle as="h2" id="pairs-title">
								{pairs.completeness === "partial" ? `First ${count} to review` : `${count} to review`}
							</CardTitle>
							<CardDescription>
								Added by an import with &ldquo;Add, review later&rdquo;. Each pair stays until you merge them, retire one or
								mark them not a duplicate.
							</CardDescription>
						</CardHeading>
					</CardHeader>
					<ul className="flex flex-col">
						{shown.map((p) => (
							<PairRow
								key={pairKey(p)}
								pair={p}
								detail={`May be ${p.with.displayName}`}
								notice={notice(p)}
								actions={
									<>
										<Button
											variant="ghost"
											size="sm"
											onClick={() => run(p)}
											aria-label={`${p.person.displayName} and ${p.with.displayName} are not a duplicate`}
										>
											Not a duplicate
										</Button>
										<IntentLink
											href={pairHref(p.person.id, p.with.id)}
											aria-label={`Review ${p.person.displayName} and ${p.with.displayName}`}
											className={buttonVariants({ variant: "secondary", size: "sm" })}
										>
											Review
										</IntentLink>
									</>
								}
							/>
						))}
					</ul>
				</Card>
			)}
		</>
	);
}

/**
 * /people/duplicates?view=dismissed (D-790): the pairs marked "Not a duplicate", newest first, with who marked each one
 * and when. Restore puts a pair back on the list in its import order.
 */
export function DismissedPairs({ pairs }: { pairs: Dismissed }) {
	const { shown, notice, run, said } = usePairs(pairs.items, "restore");
	const count = shown.length;
	const day = new Intl.DateTimeFormat("en-US", { timeZone: pairs.zone, month: "short", day: "numeric", year: "numeric" });
	return (
		<>
			<Said text={said} />
			{!count ? (
				<Card>
					<EmptyState
						icon={UserMultiple02Icon}
						title="Nothing dismissed"
						headingLevel="h2"
						action={
							<IntentLink href="/people/duplicates" className={buttonVariants({ variant: "primary" })}>
								Back to possible duplicates
							</IntentLink>
						}
					>
						Nothing has been marked &ldquo;Not a duplicate&rdquo;. A pair you mark shows here, so you can restore it.
					</EmptyState>
				</Card>
			) : (
				<Card as="section" aria-labelledby="dismissed-title">
					<CardHeader className="mb-1">
						<CardHeading>
							<CardTitle as="h2" id="dismissed-title">
								{pairs.completeness === "partial" ? `Latest ${count} dismissed` : `${count} dismissed`}
							</CardTitle>
							<CardDescription>
								Pairs marked not a duplicate. Restore puts a pair back on the list to review.
							</CardDescription>
						</CardHeading>
					</CardHeader>
					<ul className="flex flex-col">
						{shown.map((p) => (
							<PairRow
								key={pairKey(p)}
								pair={p}
								detail={`Not ${p.with.displayName}`}
								meta={`Dismissed by ${p.dismissedBy ?? "a former member"} on ${day.format(new Date(p.dismissedAt))}`}
								notice={notice(p)}
								actions={
									<Button
										variant="secondary"
										size="sm"
										onClick={() => run(p)}
										aria-label={`Restore ${p.person.displayName} and ${p.with.displayName}`}
									>
										Restore
									</Button>
								}
							/>
						))}
					</ul>
				</Card>
			)}
		</>
	);
}

function PairRow({
	pair,
	detail,
	meta,
	notice,
	actions,
}: {
	pair: Pair;
	detail: string;
	meta?: string;
	notice: string | undefined;
	actions: ReactNode;
}) {
	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line py-3 first:border-t-0">
			<div className="flex min-w-0 flex-[1_1_14rem] items-center gap-3">
				<Avatar name={pair.person.displayName} size="sm" decorative />
				<div className="min-w-0 flex-1">
					<p className="truncate font-medium text-ink">{pair.person.displayName}</p>
					<p className="truncate text-sm text-text-3">{detail}</p>
					{meta ? <p className="truncate text-sm text-text-3">{meta}</p> : null}
				</div>
			</div>
			<div className="ml-auto flex flex-none items-center gap-2">{actions}</div>
			{notice ? (
				// The row's button left with the row, so the notice takes focus when the row comes back.
				<div className="basis-full">
					<Problem key={notice}>{notice}</Problem>
				</div>
			) : null}
		</li>
	);
}

/** Says a saved change to screen readers: the row it names has left the list. */
function Said({ text }: { text: string }) {
	return (
		<p role="status" className="sr-only">
			{text}
		</p>
	);
}
