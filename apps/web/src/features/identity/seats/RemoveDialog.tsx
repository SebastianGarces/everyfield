"use client";

import {
	MAX_REMOVAL_ITEMS,
	removalReviewResult,
	removeSeatRequest,
	seatMutationResult,
} from "@everyfield/contracts/identity";
import { UserRemove01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTrigger,
	Field,
	Select,
	Skeleton,
} from "@everyfield/ui/controls";
import { useState, type ReactNode } from "react";
import type { z } from "zod";
import { Refusal, useIntent } from "../../organizations/intent";
import { ProblemLine } from "../../organizations/parts";
import { readRemovalReview, runSeatCommand } from "./actions";
import type { Seat } from "./model";

type Review = z.infer<typeof removalReviewResult>;
type Duty = Review["duties"][number];
type RemoveCommand = ReturnType<typeof removeSeatRequest.parse>;
type Load = { attempt: number } & (
	{ status: "loading" } | { status: "failed" } | { status: "too_large" } | { status: "ready"; review: Review }
);

const NEEDS_OWNER = "needs_owner";
const KIND: Record<Duty["kind"], string> = {
	task: "Task",
	follow_up: "Follow-up",
	evaluation: "Evaluation",
	pipeline_person: "Pipeline person",
	program: "Program director",
};

function refusedText(code: string | null): string {
	switch (code) {
		case "conflict":
			return "Something changed since this opened, so the duties were loaded again. Check them, then remove the seat.";
		case "protected_owner":
			return "The Owner's seat cannot be removed.";
		default:
			return "The seat was not removed. One of the people you chose may no longer have a seat. Check the list and try again.";
	}
}

/**
 * Remove an ordinary seat (seats.remove, REQ-IDN-019). Opening the dialog reads the seat's open duties and the seats
 * that may take them (ruling D52); every duty needs a new owner or a visible Needs owner before Remove is enabled.
 * Each opening reads again, and Remove waits for that read. A lost reply locks the choices: Try again resends the
 * same command, and closing the dialog reloads the list.
 */
export function RemoveDialog({
	seat,
	workspaceName,
	onRemoved,
	onClosedUnconfirmed,
	trigger,
}: {
	seat: Seat;
	workspaceName: string;
	/** The confirmed removal: what to tell the person, and the seat's revision as saved now. */
	onRemoved: (message: string, revision: Seat["revision"]) => void;
	onClosedUnconfirmed: () => void;
	trigger: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [load, setLoad] = useState<Load>({ attempt: 0, status: "loading" });
	const [choices, setChoices] = useState<Record<string, string>>({});
	const [checked, setChecked] = useState(false);
	const intent = useIntent<RemoveCommand>("seat-remove");
	const locked = intent.held !== null || intent.pending !== null;

	async function read(attempt: number) {
		setLoad({ attempt, status: "loading" });
		setChoices({});
		setChecked(false);
		try {
			const r = await readRemovalReview(seat.seatId);
			if (r.status === "refused" && r.code === "removal_too_large")
				return setLoad((l) => (l.attempt === attempt ? { attempt, status: "too_large" } : l));
			if (r.status !== "ok") throw new Error(r.code);
			const review = removalReviewResult.parse(r.value);
			setLoad((l) => (l.attempt === attempt ? { attempt, status: "ready", review } : l));
		} catch {
			setLoad((l) => (l.attempt === attempt ? { attempt, status: "failed" } : l));
		}
	}

	function change(next: boolean) {
		if (!next && intent.pending !== null) return;
		setOpen(next);
		if (next) void read(load.attempt + 1);
		else if (intent.held !== null) {
			intent.release();
			onClosedUnconfirmed();
		}
	}

	const review = load.status === "ready" ? load.review : null;
	const missing = review ? review.duties.filter((d) => !choices[d.dutyId]) : [];
	const stuck = review ? review.duties.filter((d) => d.needsRecipient && review.recipients.length === 0) : [];

	async function remove() {
		if (!review) return;
		setChecked(true);
		if (!intent.held && (missing.length || stuck.length)) return;
		const result = await intent.run(
			seat.seatId,
			(requestKey) =>
				removeSeatRequest.parse({
					requestKey,
					expectedRevision: review.expectedRevision,
					input: {
						seatId: review.seatId,
						expectedRole: review.expectedRole,
						handoffs: review.duties.map((d) =>
							choices[d.dutyId] === NEEDS_OWNER
								? { kind: "needs_owner", dutyId: d.dutyId, expectedRevision: d.expectedRevision }
								: {
										kind: "assign",
										dutyId: d.dutyId,
										expectedRevision: d.expectedRevision,
										recipientAccountId: choices[d.dutyId],
									},
						),
					},
				}),
			async (command) => {
				const reply = await runSeatCommand("remove", command);
				if (reply.status === "refused") throw new Refusal(reply.code);
				return seatMutationResult.parse(reply.value);
			},
			() => true,
		);
		if (result.ok) {
			const moved = result.reply.duties.filter((d) => d.status === "moved").length;
			const waiting = result.reply.duties.filter((d) => d.status === "needs_owner").length;
			const handed = [
				moved ? `${moved} ${moved === 1 ? "duty has" : "duties have"} a new owner` : null,
				waiting ? `${waiting} ${waiting === 1 ? "duty needs" : "duties need"} an owner` : null,
			].filter(Boolean);
			setOpen(false);
			onRemoved(
				`${seat.displayName} no longer has a seat. Their person record and history stay.${handed.length ? ` ${handed.join("; ")}.` : ""}`,
				result.reply.revision,
			);
			return;
		}
		// A refusal means this review is out of date; read it again so the next attempt carries current revisions.
		if (result.problem === "refused") void read(load.attempt + 1);
	}

	const recipientOptions = (duty: Duty) => [
		...(review?.recipients ?? []).map((r) => ({ value: r.accountId, label: r.displayName })),
		...(duty.needsRecipient ? [] : [{ value: NEEDS_OWNER, label: "Needs owner" }]),
	];

	return (
		<Dialog open={open} onOpenChange={change}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent size="md">
				<DialogHeader
					icon={UserRemove01Icon}
					tone="magenta"
					title={`Remove ${seat.displayName}'s seat?`}
					description={`${seat.displayName} will no longer sign in to ${workspaceName}. Their sessions end now. Their person record, history and past work stay.`}
				/>
				<DialogBody>
					<div aria-busy={load.status === "loading"} className="flex flex-col gap-4 pb-1">
						{load.status === "loading" ? (
							<>
								<span className="sr-only" role="status">
									Checking open work
								</span>
								<Skeleton shape="line" height={20} width="60%" />
								<Skeleton shape="block" height={56} />
							</>
						) : load.status === "failed" ? (
							<ProblemLine
								problem="refused"
								refused="Their open work did not load. Check your connection, then try again."
								action={
									<Button size="sm" variant="secondary" onClick={() => void read(load.attempt + 1)}>
										Try again
									</Button>
								}
							/>
						) : load.status === "too_large" ? (
							<p className="text-text-2">
								{seat.displayName} has more than {MAX_REMOVAL_ITEMS.toLocaleString("en-US")} open duties or possible new
								owners, more than one removal can hand over. Give some of their work to other people first.
							</p>
						) : review && review.duties.length === 0 ? (
							<p className="text-text-2">{seat.displayName} has no open tasks or duties to hand over.</p>
						) : review ? (
							<>
								<p className="text-text-2">
									Choose who takes each open duty. Needs owner keeps it visible until someone takes it. Closed work
									stays as it is.
								</p>
								{review.duties.length > 1 && review.recipients.length > 0 ? (
									<Field
										label="Give every duty to"
										hint={`Fills all ${review.duties.length} choices below. You can still change any of them.`}
									>
										<Select
											placeholder="Choose one person for all"
											options={[
												...review.recipients.map((r) => ({ value: r.accountId, label: r.displayName })),
												{ value: NEEDS_OWNER, label: "Needs owner" },
											]}
											value=""
											disabled={locked}
											onValueChange={(v) =>
												setChoices(
													Object.fromEntries(
														review.duties.map((d) => [
															d.dutyId,
															v === NEEDS_OWNER && d.needsRecipient ? (choices[d.dutyId] ?? "") : v,
														]),
													),
												)
											}
										/>
									</Field>
								) : null}
								<ul className="flex flex-col gap-4" aria-label="Open duties">
									{review.duties.map((duty) => (
										<li key={duty.dutyId}>
											<Field
												label={duty.label}
												hint={KIND[duty.kind]}
												error={
													checked && duty.needsRecipient && review.recipients.length === 0
														? "No one else can take this. Give another person a seat first."
														: checked && !choices[duty.dutyId]
															? "Choose who takes this."
															: undefined
												}
											>
												<Select
													aria-label={`New owner for ${duty.label}`}
													placeholder="Choose who takes this"
													options={recipientOptions(duty)}
													value={choices[duty.dutyId] ?? ""}
													disabled={locked}
													invalid={checked && !choices[duty.dutyId]}
													onValueChange={(v) => setChoices({ ...choices, [duty.dutyId]: v })}
												/>
											</Field>
										</li>
									))}
								</ul>
							</>
						) : null}
						<ProblemLine problem={intent.problem} refused={refusedText(intent.code)} />
					</div>
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" disabled={intent.pending !== null} onClick={() => change(false)}>
						Cancel
					</Button>
					<Button
						variant="danger"
						loading={intent.pending !== null}
						disabled={load.status !== "ready" && !intent.held}
						onClick={() => void remove()}
					>
						{intent.held ? "Try again" : "Remove seat"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
