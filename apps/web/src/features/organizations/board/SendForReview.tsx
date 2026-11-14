"use client";

import type { NoteReview, PipelineBoard } from "@everyfield/contracts/organizations";
import {
	Button,
	Checkbox,
	ConfirmDialog,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	Select,
} from "@everyfield/ui/controls";
import { useState, type FormEvent } from "react";
import { sendAnswers, withdrawReview } from "./actions";
import { formatDay, refusalText } from "./model";
import { Problem } from "./Problem";

// Kept answers sent for review (T-385, D-1507): an Owner or Admin chooses some questions of a kept-answers note, names
// the group and picks a current seat of the organization. The reviewer reads only those questions, with the note's
// current answers, and nothing else of the person. No answer goes into the notice or its email.

type Staff = PipelineBoard["staff"];
type Answer = Awaited<ReturnType<typeof sendAnswers>>;
const lost = (): Answer => ({ status: "lost" });

/** The dialog behind "Send for review". Send stays off until a question, a group name and a reviewer are chosen. */
export function SendForReviewDialog({
	open,
	onOpenChange,
	noteId,
	person,
	questions,
	staff,
	onSent,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	noteId: string;
	person: string;
	questions: string[];
	staff: Staff;
	onSent: () => Promise<void>;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="md">
				{open ? <SendForm noteId={noteId} person={person} questions={questions} staff={staff} onSent={onSent} /> : null}
			</DialogContent>
		</Dialog>
	);
}

function SendForm({
	noteId,
	person,
	questions,
	staff,
	onSent,
}: {
	noteId: string;
	person: string;
	questions: string[];
	staff: Staff;
	onSent: () => Promise<void>;
}) {
	// One ID per dialog: a resend after a lost answer, or a second click, makes no second send.
	const [reviewId] = useState(() => crypto.randomUUID());
	const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
	const [groupName, setGroupName] = useState("");
	const [reviewer, setReviewer] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const ready = chosen.size > 0 && groupName.trim() !== "" && reviewer !== "";
	function toggle(question: string, on: boolean) {
		const next = new Set(chosen);
		if (on) next.add(question);
		else next.delete(question);
		setChosen(next);
	}
	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!ready || saving) return;
		setSaving(true);
		const answer = await sendAnswers({
			reviewId,
			noteId,
			groupName: groupName.trim(),
			questions: questions.filter((q) => chosen.has(q)),
			reviewerSeatId: reviewer,
		}).catch(lost);
		if (answer.status !== "ok") {
			setSaving(false);
			setProblem(refusalText(answer));
			return;
		}
		await onSent();
	}
	return (
		<form onSubmit={submit} noValidate className="contents">
			<DialogHeader
				title="Send for review"
				description={`The reviewer sees only the questions you choose, with ${person}’s answers. They see nothing else of ${person}, and the email they get holds no answers.`}
			/>
			<DialogBody className="flex flex-col gap-5">
				<fieldset className="flex flex-col gap-2.5">
					<legend className="mb-2 text-sm font-medium text-ink">Questions</legend>
					{questions.map((q) => (
						<Checkbox key={q} label={q} checked={chosen.has(q)} onCheckedChange={(v) => toggle(q, v === true)} />
					))}
				</fieldset>
				<Field label="Group name" hint="For example, Credentialing questions. The reviewer sees this name.">
					<Input value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={120} />
				</Field>
				<Field label="Reviewer" hint="Anyone with a seat in your organization.">
					<Select
						value={reviewer}
						onValueChange={setReviewer}
						placeholder="Choose a staff member"
						options={staff.map((s) => ({ value: s.seatId, label: s.name }))}
					/>
				</Field>
				<Problem text={problem} />
			</DialogBody>
			<DialogFooter>
				<Button type="submit" variant="primary" loading={saving} disabled={!ready}>
					Send
				</Button>
			</DialogFooter>
		</form>
	);
}

/** The note's sends that are not withdrawn: who, which group and when, its questions, and Withdraw for an Owner or Admin. */
export function NoteReviews({
	reviews,
	canWithdraw,
	onChanged,
}: {
	reviews: NoteReview[];
	canWithdraw: boolean;
	onChanged: () => Promise<void>;
}) {
	if (!reviews.length) return null;
	return (
		<ul className="mt-1 flex flex-col gap-2 border-t border-line pt-2.5">
			{reviews.map((r) => (
				<ReviewItem key={r.id} review={r} canWithdraw={canWithdraw} onChanged={onChanged} />
			))}
		</ul>
	);
}

function ReviewItem({
	review,
	canWithdraw,
	onChanged,
}: {
	review: NoteReview;
	canWithdraw: boolean;
	onChanged: () => Promise<void>;
}) {
	const [confirming, setConfirming] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	return (
		<li className="flex flex-col gap-1">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="text-sm font-medium text-ink [overflow-wrap:anywhere]">
					Sent to {review.reviewer}: {review.groupName}, {formatDay(review.sentOn)}
				</span>
				{canWithdraw ? (
					<Button variant="ghost" size="sm" className="ml-auto" onClick={() => setConfirming(true)}>
						Withdraw
					</Button>
				) : null}
			</div>
			<p className="text-xs text-text-2 [overflow-wrap:anywhere]">{review.questions.join(" · ")}</p>
			{problem ? <p className="text-sm text-magenta-600">{problem}</p> : null}
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={`Withdraw from ${review.reviewer}?`}
				description={`${review.reviewer} can no longer read these answers. The send stays in the history.`}
				confirmLabel="Withdraw"
				onConfirm={async () => {
					const answer = await withdrawReview({ reviewId: review.id }).catch(lost);
					if (answer.status !== "ok") setProblem(refusalText(answer));
					else await onChanged();
				}}
			/>
		</li>
	);
}
