"use client";

import type * as c from "@everyfield/contracts/meetings";
import { RefreshIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardIcon,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	IntentLink,
	Spinner,
	StatePanel,
	useToast,
} from "@everyfield/ui/controls";
import { useState, useTransition } from "react";
import type { z } from "zod";
import { SaveNotice, useSaveIntent } from "../../components/save/parts.tsx";
import { previewRoster, updateRoster } from "./actions.ts";
import { problemText, type Detail, type Guest, type Outcome } from "./model.ts";
import { PENDING, type Change, type PendingGuest } from "./page-state.ts";

type Preview = z.infer<typeof c.rosterPreview>;
type Person = Preview["add"][number];
const names = (people: Person[]) => people.map((p) => p.displayName);

/**
 * A team meeting's guest list came from its ministry when the meeting was made, and does not follow later changes
 * (REQ-MTG-007). An Owner or Admin can review an update from the ministry: who would be added, removed and kept. Cancel
 * changes nothing; Update applies exactly that review, shown at once and confirmed by the answer.
 */
export function RosterUpdate({
	meeting,
	canWrite,
	project,
	onUpdated,
}: {
	meeting: Detail;
	canWrite: boolean;
	project: (change: Change) => void;
	onUpdated: (added: Guest[], removedPersonIds: string[]) => void;
}) {
	const team = meeting.team;
	const toast = useToast();
	const lane = useSaveIntent({ explain: rosterProblem });
	const [, startTransition] = useTransition();
	const [open, setOpen] = useState(false);
	const [preview, setPreview] = useState<Outcome<Preview> | null>(null);
	if (!team) return null;

	function review() {
		setPreview(null);
		setOpen(true);
		previewRoster(meeting.id).then(setPreview, () => setPreview({ status: "lost" }));
	}
	function confirm(p: Preview) {
		setOpen(false);
		startTransition(async () => {
			project({
				kind: "roster",
				add: p.add.map(pending),
				removePersonIds: p.remove.map((r) => r.personId),
			});
			await lane.save({
				what: "The guest list update",
				done: "saved",
				send: (key) =>
					updateRoster(
						key,
						meeting.id,
						p.add.map((a) => a.personId),
						p.remove.map((r) => r.personId),
					),
				ok: (value: z.infer<typeof c.rosterUpdateResult>) => {
					onUpdated(value.added, value.removedPersonIds);
					toast({ tone: "success", message: updatedText(value.added.length, value.removedPersonIds.length) });
				},
			});
		});
	}

	return (
		<>
			<SaveNotice {...lane.noticeProps} dialogOpen={open} />
			<Card as="section" aria-label="Guest list source" className="flex flex-wrap items-center gap-x-4 gap-y-3">
				<CardIcon icon={UserGroupIcon} tone="violet" size={36} />
				<p className="min-w-[220px] flex-1 text-sm text-text-2">
					The guest list was copied from{" "}
					<IntentLink href={`/ministries/${team.id}`} className="cursor-pointer font-medium text-ink underline">
						{team.name}
					</IntentLink>{" "}
					when this meeting was made. It does not follow later changes to the ministry.
				</p>
				{canWrite ? (
					<Button variant="secondary" icon={RefreshIcon} disabled={lane.wait !== null} onClick={review}>
						Update from ministry
					</Button>
				) : null}
			</Card>
			<Dialog open={open} onOpenChange={setOpen}>
				{open ? (
					<RosterDialog
						teamName={team.name}
						preview={preview}
						onRetry={review}
						onCancel={() => setOpen(false)}
						onConfirm={confirm}
					/>
				) : null}
			</Dialog>
		</>
	);
}

function RosterDialog({
	teamName,
	preview,
	onRetry,
	onCancel,
	onConfirm,
}: {
	teamName: string;
	preview: Outcome<Preview> | null;
	onRetry: () => void;
	onCancel: () => void;
	onConfirm: (p: Preview) => void;
}) {
	const p = preview?.status === "ok" ? preview.value : null;
	const same = p !== null && p.add.length === 0 && p.remove.length === 0;
	return (
		<DialogContent>
			<DialogHeader
				icon={RefreshIcon}
				tone="violet"
				title={same ? "The guest list is up to date" : "Update from ministry"}
				description={
					same
						? `Everyone serving in ${teamName} now is already on the guest list.`
						: `Compare the guest list with the people serving in ${teamName} now. Nothing changes until you update.`
				}
			/>
			<DialogBody className="flex flex-col gap-4">
				{preview === null ? (
					<p role="status" className="flex items-center gap-2 py-2 text-sm text-text-3">
						<Spinner size={16} /> Comparing with {teamName}…
					</p>
				) : preview.status !== "ok" ? (
					<StatePanel tone="error" title="The comparison did not load" headingLevel="h3">
						{preview.status === "refused" ? rosterProblem(preview.code) : "Nothing was changed. Try again."}
					</StatePanel>
				) : (
					<>
						{p!.add.length ? (
							<Group title={`Add ${p!.add.length}`} people={names(p!.add)}>
								They serve in {teamName} now. They join as invited, absent, RSVP pending.
							</Group>
						) : null}
						{p!.remove.length ? (
							<Group title={`Remove ${p!.remove.length}`} people={names(p!.remove)}>
								They no longer serve in {teamName}. Their RSVP links close and their history stays.
							</Group>
						) : null}
						{p!.kept.length ? (
							<Group title={`Keep ${p!.kept.length}`} people={names(p!.kept)}>
								They no longer serve in {teamName}, but they are marked present, so they stay.
							</Group>
						) : null}
						{!same ? <p className="text-sm text-text-3">Guests you added by hand stay on the list.</p> : null}
					</>
				)}
			</DialogBody>
			<DialogFooter>
				{preview !== null && preview.status !== "ok" ? (
					<>
						<Button variant="secondary" type="button" onClick={onCancel}>
							Close
						</Button>
						<Button variant="primary" type="button" onClick={onRetry}>
							Try again
						</Button>
					</>
				) : same ? (
					<Button variant="secondary" type="button" onClick={onCancel}>
						Close
					</Button>
				) : (
					<>
						<Button variant="secondary" type="button" onClick={onCancel}>
							Cancel
						</Button>
						<Button variant="primary" type="button" disabled={p === null} onClick={() => p && onConfirm(p)}>
							Update guest list
						</Button>
					</>
				)}
			</DialogFooter>
		</DialogContent>
	);
}

function Group({ title, people, children }: { title: string; people: string[]; children: string | string[] }) {
	return (
		<section className="flex flex-col gap-1.5">
			<h3 className="font-sans text-sm font-semibold text-ink">{title}</h3>
			<p className="text-sm text-text-2">{children}</p>
			<ul className="flex flex-wrap gap-1.5">
				{people.map((name, i) => (
					<li key={`${name}-${i}`} className="rounded-full bg-surface-sunken px-2.5 py-0.5 text-sm text-ink">
						{name}
					</li>
				))}
			</ul>
		</section>
	);
}

/** A person the update adds, as the guest list shows them before the answer. */
function pending(p: Person): PendingGuest {
	return {
		id: `${PENDING}${p.personId}`,
		revision: null,
		person: { personId: p.personId, displayName: p.displayName, state: "live" },
		inviter: null,
		rsvp: "pending",
		rsvpSource: null,
		rsvpAt: null,
		presence: "absent",
		hasCard: false,
	};
}

function updatedText(added: number, removed: number) {
	const parts = [added ? `${added} added` : null, removed ? `${removed} removed` : null].filter(Boolean);
	return parts.length ? `Guest list updated: ${parts.join(", ")}.` : "The guest list was already up to date.";
}

function rosterProblem(code: string) {
	if (code === "conflict")
		return "The ministry or the guest list changed since you opened the update. Nothing was changed. Open it again to see the latest.";
	if (code === "wrong_meeting_type") return "This meeting is not a team meeting, so it has no ministry to update from.";
	return problemText(code);
}
