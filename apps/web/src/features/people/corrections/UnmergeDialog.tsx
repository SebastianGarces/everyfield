"use client";

import { Alert02Icon, ArrowTurnBackwardIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import {
	Button,
	CalloutLabel,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	IntentLink,
	Skeleton,
	Spinner,
} from "@everyfield/ui/controls";
import { Avatar, KeyValue, KeyValueList } from "@everyfield/ui/display";
import { focusOnMount } from "@everyfield/ui/foundations";
import { useState } from "react";
import type { z } from "zod";
import { runSave, type PersonStore } from "../person.store.ts";
import { useRead } from "../../../components/read.tsx";
import { fresh, usePersonState, When } from "../parts.tsx";
import type { PersonDraft } from "../StageDialog.tsx";
import { unmergePair, type Unmerged } from "./actions.ts";
import { unmergeRead } from "./intent.ts";
import { conflictText, counted, FIELD_LABEL, kindTitle, listText } from "./model.ts";
import { Problem } from "./parts.tsx";
import type { UnmergeView } from "./server.ts";

type PlantPerson = z.infer<typeof people.plantPerson>;
type Restored = UnmergeView["preview"]["restores"];
const first = (name: string) => name.split(" ")[0] ?? name;

export function UnmergeDialog({
	mergeId,
	store,
	onClose,
	onUnmerged,
}: {
	mergeId: string;
	store: PersonStore<PlantPerson, PersonDraft>;
	onClose: () => void;
	onUnmerged: (done: Unmerged | null) => Promise<boolean>;
}) {
	const read = useRead(unmergeRead, mergeId);
	const preview = read.value ?? null;
	const [problem, setProblem] = useState<{ n: number; text: string; retry?: boolean } | null>(null);
	const say = (p: { text: string; retry?: boolean }) => setProblem((old) => ({ ...p, n: (old?.n ?? 0) + 1 }));
	const [done, setDone] = useState<{ restored: Restored; names: UnmergeView["names"] } | null>(null);
	const [pending, setPending] = useState(false);
	const [page, setPage] = useState<"updating" | "updated" | "stale" | null>(null);
	async function refreshPage(done: Unmerged | null) {
		setPage("updating");
		setPage((await onUnmerged(done).catch(() => false)) ? "updated" : "stale");
	}
	const slot = `unmerge:${mergeId}`;
	const uncertain = usePersonState(store).errors[slot] === "lost";

	const close = () => {
		onClose();
		unmergeRead.forget(mergeId);
	};

	async function unmerge(view: UnmergeView) {
		const rev = view.preview.reviewRevision;
		setPending(true);
		setProblem(null);
		const r = await runSave(store, slot, { mergeId, rev }, (key) => unmergePair(key, rev, mergeId), {
			fresh,
		});
		if (r === null) {
			setPending(false);
			return say({ text: "Another change to this person is still saving. Try again in a moment." });
		}
		if (r.status === "ok") {
			setPending(false);
			setDone({ restored: r.value.result.restored, names: view.names });
			return refreshPage(r.value);
		}
		if (r.status === "lost") {
			setPending(false);
			return say({
				retry: true,
				text: "We did not hear back from the server, so the Unmerge may have happened. Try again; it will not run twice.",
			});
		}
		const again = await unmergeRead.refresh(mergeId);
		setPending(false);
		if (again.status === "ok" && again.value.preview.state === "unmerged") {
			setDone({ restored: view.preview.restores, names: again.value.names });
			return refreshPage(null);
		}
		say({
			text:
				r.code === "conflict"
					? `${view.names.survivor} changed after this preview. The preview now shows the current state.`
					: r.code === "inverse_conflict"
						? "Something changed since the merge, so Unmerge cannot run. The preview below says what."
						: "You cannot unmerge these people. Your seat may have changed; reload the page.",
		});
	}

	const view = preview?.status === "ok" ? preview.value : null;
	const p = view?.preview;
	const names = done?.names ?? view?.names;
	const blocked = Boolean(p && p.state === "merged" && p.conflicts.length);
	const finished = done
		? { ...done, earlier: false }
		: p?.state === "unmerged" && view
			? { restored: [], names: view.names, earlier: true }
			: null;

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && page !== "updating" && close()}>
			<DialogContent size="md" aria-busy={pending || preview === null || undefined}>
				<DialogHeader
					icon={ArrowTurnBackwardIcon}
					tone="blue"
					title={names ? `Unmerge ${names.source}` : "Unmerge"}
					description={
						p ? (
							<>
								Merged <When at={p.mergedAt} />
							</>
						) : undefined
					}
				/>
				<DialogBody className="flex flex-col gap-4">
					{preview === null ? (
						<div className="flex flex-col gap-3">
							<span className="sr-only" role="status">
								Loading what Unmerge restores
							</span>
							<Skeleton className="h-4 w-4/5" />
							<Skeleton className="h-11 w-full rounded-md" />
							<Skeleton className="h-11 w-full rounded-md" />
						</div>
					) : !view || !p || !names ? (
						<Problem>
							{preview.status === "lost"
								? uncertain
									? "The Unmerge preview did not load, so this page cannot tell whether your last Unmerge went through. Try again to see where they stand."
									: "The Unmerge preview did not load. Try again in a moment."
								: "You cannot see this Unmerge. Only Owners and Admins can unmerge people."}
						</Problem>
					) : finished ? (
						<>
							<Finished restored={finished.restored} names={finished.names} preview={p} earlier={finished.earlier} />
							{page === "updating" ? (
								<p role="status" className="flex items-center gap-2 text-sm text-text-2">
									<Spinner size={16} />
									Updating the page
								</p>
							) : page === "stale" ? (
								<Problem>
									The Unmerge is saved, but this page could not update to show it. Reload the page to see both people as
									they are now.
								</Problem>
							) : null}
						</>
					) : (
						<>
							<p>
								{blocked
									? `An Unmerge would bring ${names.source} back as their own person and move these back:`
									: `${names.source} comes back as their own person. ${
											p.fields.length
												? `${names.survivor} gets back the details they had before the merge.`
												: `${names.survivor}'s details stay as they are.`
										}`}
							</p>
							<KeyValueList>
								{p.fields.length ? (
									<KeyValue
										size="sm"
										k={`${first(names.survivor)}'s details`}
										value={`${listText(p.fields.map((f) => FIELD_LABEL[f].toLowerCase())).replace(/^./, (c) => c.toUpperCase())} go back`}
									/>
								) : null}
								{p.restores.map((r) => (
									<KeyValue
										key={r.kind}
										size="sm"
										k={kindTitle(r.kind)}
										value={`${r.count} back to ${first(names.source)}`}
									/>
								))}
							</KeyValueList>
							{blocked ? (
								<div className="rounded-md bg-surface px-4 py-3.5">
									<CalloutLabel tone="magenta" icon={Alert02Icon}>
										Cannot unmerge
									</CalloutLabel>
									<ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-ink-2">
										{p.conflicts.map((c) => (
											<li key={c}>{conflictText(c, names)}</li>
										))}
									</ul>
									<p className="mt-2 text-sm">
										An Unmerge would lose those changes, so Everyfield will not run it. Correct {first(names.survivor)}
										&rsquo;s details by hand instead; each change is kept in the history.
									</p>
								</div>
							) : (
								<CalloutLabel tone="green" icon={Tick02Icon}>
									Nothing changed since the merge
								</CalloutLabel>
							)}
							{blocked ? null : (
								<p className="text-xs text-text-3">The merge and the Unmerge both stay in the history.</p>
							)}
						</>
					)}
					{problem ? <Problem request={problem.n}>{problem.text}</Problem> : null}
				</DialogBody>
				<DialogFooter>
					{preview !== null && preview.status !== "ok" ? (
						<Button variant="secondary" onClick={read.retry}>
							Try again
						</Button>
					) : null}
					{finished && page === "stale" ? (
						<Button variant="secondary" onClick={() => location.reload()}>
							Reload page
						</Button>
					) : null}
					{finished || blocked || !view ? (
						<Button variant={finished ? "primary" : "secondary"} disabled={page === "updating"} onClick={close}>
							{finished ? "Done" : "Close"}
						</Button>
					) : (
						<>
							<Button variant="secondary" disabled={pending} onClick={close}>
								Cancel
							</Button>
							<Button variant="primary" loading={pending} onClick={() => unmerge(view)}>
								{problem?.retry ? "Try again" : "Unmerge"}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function Finished({
	restored,
	names,
	preview,
	earlier,
}: {
	restored: Restored;
	names: UnmergeView["names"];
	preview: UnmergeView["preview"];
	earlier: boolean;
}) {
	return (
		<div role="status" className="flex flex-col gap-3">
			<CalloutLabel tone="green" icon={Tick02Icon}>
				{earlier ? "Already undone" : "Unmerged"}
			</CalloutLabel>
			{earlier ? (
				<p ref={focusOnMount} tabIndex={-1} className="text-ink-2 outline-none">
					This merge of {names.source} into {names.survivor} was undone earlier, so there is nothing to undo here. Open
					either person to see where they stand now.
				</p>
			) : (
				<p ref={focusOnMount} tabIndex={-1} className="text-ink-2 outline-none">
					{names.source} is their own person again.{" "}
					{preview.fields.length ? `${names.survivor} has the details from before the merge. ` : null}
					{restored.length
						? `${listText(restored.map((r) => counted(r.kind, r.count)))} moved back to ${first(names.source)}.`
						: null}
				</p>
			)}
			<ul className="flex flex-col">
				{(
					[
						[preview.survivorId, names.survivor],
						[preview.sourceId, names.source],
					] as const
				).map(([id, name]) => (
					<li key={id} className="border-t border-line first:border-t-0">
						<IntentLink
							href={`/people/${id}`}
							className="-mx-2 flex items-center gap-3 rounded-md px-2 py-3 text-ink transition-colors hover:bg-hover"
						>
							<Avatar name={name} size="sm" decorative />
							<span className="font-medium">{name}</span>
						</IntentLink>
					</li>
				))}
			</ul>
			<p className="text-xs text-text-3">Both histories show the merge and the Unmerge.</p>
		</div>
	);
}
