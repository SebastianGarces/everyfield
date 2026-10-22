"use client";

import { ArrowDataTransferHorizontalIcon } from "@hugeicons/core-free-icons";
import {
	Button,
	Checkbox,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Select,
	Spinner,
	StatePanel,
} from "@everyfield/ui/controls";
import { useEffect, useState } from "react";
import { executeHandoff } from "./actions.ts";
import { DutyFacts } from "./duties.tsx";
import { loadPlan, prefetchSeats } from "./fetch.ts";
import {
	HANDOFF_LIMIT,
	keepSelection,
	problemText,
	type Account,
	type HandoffPlan,
	type HandoffResult,
	type Outcome,
} from "./model.ts";
import { DialogNotice, NoticeInDialog, SaveButton, useSaveIntent } from "../../components/save/parts.tsx";

type Seat = { accountId: string; displayName: string; role: string };

/**
 * The handoff's state and its save lane (REQ-TSK-013), held by the page, not the dialog. Closing the dialog while a
 * move is saving or its result is unknown keeps the lane, the selection and Check again on the page (C58, C68): only a
 * server answer settles it. A plain Cancel with nothing pending changes nothing and starts the next opening afresh.
 */
export function useHandoff(onMoved: (r: HandoffResult, plan: HandoffPlan) => void) {
	const [seats, setSeats] = useState<Outcome<{ items: Seat[] }> | null>(null);
	const [from, setFrom] = useState("");
	const [plan, setPlan] = useState<Outcome<HandoffPlan> | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [to, setTo] = useState("");
	const [toError, setToError] = useState<string | null>(null);
	const [result, setResult] = useState<HandoffResult | null>(null);
	const lane = useSaveIntent({ explain: problemText });

	/** Reads the preview. `keep` keeps the person's selection and recipient for follow-ups still in it. */
	async function preview(account: string, keep: boolean) {
		if (!keep) setPlan(null);
		const r = await loadPlan(account);
		setPlan(r);
		if (r.status !== "ok") return;
		const open = r.value.duties;
		setSelected((s) => (keep ? keepSelection(s, open) : new Set(open.slice(0, HANDOFF_LIMIT).map((d) => d.taskId))));
		setTo((t) => (keep && r.value.recipients.some((x) => x.accountId === t) ? t : ""));
	}

	const p = plan?.status === "ok" ? plan.value : null;
	const chosen = p ? p.duties.filter((d) => selected.has(d.taskId)) : [];
	const recipient = p?.recipients.find((r) => r.accountId === to);

	async function submit() {
		if (!p) return;
		if (!recipient) return setToError("Choose who takes these follow-ups.");
		setToError(null);
		const input = {
			fromAccountId: p.from.accountId,
			toAccountId: recipient.accountId,
			items: chosen.slice(0, HANDOFF_LIMIT).map((d) => ({ taskId: d.taskId, expectedRevision: d.revision })),
		};
		await lane.save({
			what: `Moving ${input.items.length} follow-up${input.items.length === 1 ? "" : "s"}`,
			send: (key) => executeHandoff(key, input),
			ok: (value) => {
				setResult(value);
				onMoved(value, p);
			},
			// Out of date or the recipient lost eligibility: read the preview again and keep the person's own choices.
			refused: async (code) => {
				if (code === "conflict" || code === "handoff_target_ineligible") await preview(p.from.accountId, true);
			},
		});
	}
	/** Opens the review for one account, as the "Waiting for a handoff" list does. */
	function start(account: string) {
		if (lane.notice || lane.wait) return;
		setResult(null);
		setFrom(account);
		void preview(account, false);
	}
	/** Opens the dialog: the seats come from the intent prefetch, read again only when that copy is old or failed. */
	function opened() {
		void prefetchSeats().then(setSeats);
	}
	/** Closes the dialog. With nothing saving, unknown or refused, the next opening starts afresh (Cancel changes nothing). */
	function closed() {
		if (lane.notice || lane.wait) return;
		setFrom("");
		setPlan(null);
		setSelected(new Set());
		setTo("");
		setToError(null);
		setResult(null);
	}
	const sourceName =
		p?.from.displayName ??
		(seats?.status === "ok" ? (seats.value.items.find((s) => s.accountId === from)?.displayName ?? null) : null);
	return {
		seats,
		from,
		setFrom,
		plan,
		p,
		selected,
		setSelected,
		to,
		setTo,
		toError,
		result,
		setResult,
		lane,
		chosen,
		preview,
		submit,
		opened,
		closed,
		sourceName,
		start,
	};
}
export type Handoff = ReturnType<typeof useHandoff>;

/**
 * Hand an account's open follow-ups to an eligible owner (REQ-TSK-013). Choose whose follow-ups, review them and the
 * recipient, then move up to 100 at once, all or nothing. Cancel changes nothing; follow-ups left behind read as Needs
 * owner while their stored owner cannot own them. The save's notice shows inside the dialog while it is open.
 */
export function HandoffDialog({
	h,
	former,
	onClose,
	returnFocus,
}: {
	h: Handoff;
	/** Focus back to the button that opened the dialog (useOpener). */
	returnFocus?: (e: Event) => void;
	/** Accounts that still hold open follow-ups they can no longer own, including ones whose seat ended. */
	former: readonly (Account & { open: number })[];
	onClose: () => void;
}) {
	const { seats, from, setFrom, plan, p, selected, setSelected, to, setTo, toError, result, setResult, lane } = h;
	const { chosen, preview, submit, sourceName } = h;
	useEffect(h.opened, []); // eslint-disable-line react-hooks/exhaustive-deps
	return (
		<NoticeInDialog {...lane.noticeProps}>
			<Dialog open onOpenChange={(next) => !next && onClose()}>
				<DialogContent size="lg" onCloseAutoFocus={returnFocus}>
					<form
						noValidate
						className="contents"
						onSubmit={(e) => {
							e.preventDefault();
							if (!lane.wait && !result) void submit();
						}}
					>
						<DialogHeader
							icon={ArrowDataTransferHorizontalIcon}
							tone="blue"
							title="Hand off follow-ups"
							description="Move open follow-ups from someone who can no longer own them. Nothing moves until you confirm."
						/>
						<DialogBody className="flex flex-col gap-5 pb-1">
							<DialogNotice />
							{result ? (
								<div role="status" className="flex flex-col gap-2 text-sm text-ink-2">
									<p className="font-medium text-ink">
										Moved {result.moved.length} follow-up{result.moved.length === 1 ? "" : "s"} to{" "}
										{result.to.displayName}.
									</p>
									<p>
										{result.remainingTotal === 0
											? `${sourceName ?? "They"} has no open follow-ups left.`
											: `${result.remainingTotal} open follow-up${result.remainingTotal === 1 ? "" : "s"} still belong to ${sourceName ?? "them"}. Review them next, or leave them; they show as Needs owner while ${sourceName ?? "they"} cannot own follow-ups.`}
									</p>
								</div>
							) : (
								<>
									<Field label="Whose follow-ups">
										<Select
											value={from || undefined}
											onValueChange={(v) => {
												setFrom(v);
												void preview(v, false);
											}}
											placeholder={seats === null && !former.length ? "Loading seats" : "Choose a person"}
											disabled={seats?.status !== "ok" && !former.length}
											options={sourceOptions(seats?.status === "ok" ? seats.value.items : [], former)}
										/>
									</Field>
									{seats?.status === "refused" || seats?.status === "lost" ? (
										<p className="text-sm text-text-2">
											The current seats did not load. People who can no longer own follow-ups are still listed.
										</p>
									) : null}
									{from && plan === null ? (
										<p role="status" className="flex items-center gap-2 text-sm text-text-2">
											<Spinner size={16} /> Loading their follow-ups
										</p>
									) : null}
									{plan && plan.status !== "ok" ? (
										<p className="text-sm text-text-2">
											Their follow-ups did not load. Choose the person again to retry.
										</p>
									) : null}
									{p ? <Review plan={p} selected={selected} onSelected={setSelected} /> : null}
									{p && !p.from.protectedOwner && p.duties.length ? (
										<Field
											label="Give them to"
											error={toError}
											hint={
												p.recipients.length
													? "Only people who can own follow-ups now are listed."
													: "No one else can own follow-ups now. Give someone a committed stage first."
											}
										>
											<Select
												value={to || undefined}
												onValueChange={setTo}
												placeholder="Choose a person"
												options={p.recipients.map((r) => ({ value: r.accountId, label: r.displayName }))}
											/>
										</Field>
									) : null}
								</>
							)}
						</DialogBody>
						<DialogFooter>
							{result ? (
								<>
									{result.remainingTotal > 0 && p ? (
										<Button
											variant="secondary"
											type="button"
											onClick={() => {
												setResult(null);
												void preview(p.from.accountId, false);
											}}
										>
											Review the rest
										</Button>
									) : null}
									<Button variant="primary" type="button" onClick={onClose}>
										Done
									</Button>
								</>
							) : (
								<>
									<Button variant="secondary" type="button" onClick={onClose}>
										Cancel
									</Button>
									{p && !p.from.protectedOwner && p.duties.length ? (
										<SaveButton
											wait={lane.wait}
											saving={lane.saving}
											blocked={chosen.length ? null : "Choose at least one follow-up."}
										>
											{`Move ${Math.min(chosen.length, HANDOFF_LIMIT)} follow-up${chosen.length === 1 ? "" : "s"}`}
										</SaveButton>
									) : null}
								</>
							)}
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</NoticeInDialog>
	);
}

function Review({
	plan,
	selected,
	onSelected,
}: {
	plan: HandoffPlan;
	selected: Set<string>;
	onSelected: (s: Set<string>) => void;
}) {
	const name = plan.from.displayName ?? "This person";
	if (plan.from.protectedOwner)
		return (
			<StatePanel title="The Owner’s follow-ups stay with the Owner" headingLevel="h3">
				Follow-ups cannot be taken from the church’s Owner. Assign them one at a time if needed.
			</StatePanel>
		);
	if (plan.duties.length === 0)
		return <p className="text-sm text-text-2">{name} has no open follow-ups. Nothing needs to move.</p>;
	const full = selected.size >= HANDOFF_LIMIT;
	return (
		<div className="flex flex-col gap-2">
			<p className="text-sm text-text-2">
				{plan.from.eligible
					? `${name} can still own follow-ups. Move only the ones someone else should take.`
					: `${name} can no longer own follow-ups, so these show as Needs owner until they move.`}{" "}
				{plan.total > HANDOFF_LIMIT ? `One handoff moves up to ${HANDOFF_LIMIT}; review the rest after.` : null}
			</p>
			<fieldset className="max-h-[320px] overflow-y-auto rounded-md px-3 shadow-[inset_0_0_0_1px_var(--ef-line)]">
				<legend className="sr-only">Follow-ups to move</legend>
				{plan.duties.map((d) => {
					const on = selected.has(d.taskId);
					return (
						<Checkbox
							key={d.taskId}
							checked={on}
							disabled={!on && full}
							onCheckedChange={(v) => {
								const next = new Set(selected);
								if (v === true) next.add(d.taskId);
								else next.delete(d.taskId);
								onSelected(next);
							}}
							label={`${d.title} · ${d.person.label}`}
							description={<DutyFacts duty={d} />}
							className="border-t border-line first:border-t-0"
						/>
					);
				})}
			</fieldset>
			<p className="text-xs text-text-3" aria-live="polite">
				{selected.size} of {plan.duties.length} selected
				{full ? `. ${HANDOFF_LIMIT} is the most one handoff moves.` : ""}
			</p>
		</div>
	);
}

/**
 * Whose follow-ups can move: everyone who can no longer own the follow-ups they hold, including an account whose seat
 * ended, first, then every current seat (a demoted one included).
 */
function sourceOptions(seats: readonly Seat[], former: readonly (Account & { open: number })[]) {
	const left = former.map((f) => ({
		value: f.accountId,
		label: `${f.displayName || "A former member"} · can no longer own · ${f.open} open`,
	}));
	return [
		...left,
		...seats
			.filter((s) => !former.some((f) => f.accountId === s.accountId))
			.map((s) => ({ value: s.accountId, label: s.displayName })),
	];
}
