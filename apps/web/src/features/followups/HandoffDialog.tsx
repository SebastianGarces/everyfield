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
import { HANDOFF_LIMIT } from "@everyfield/contracts/followups";
import { executeHandoff } from "./actions.ts";
import { DutyFacts } from "./duties.tsx";
import { loadPlan, seatList } from "./fetch.ts";
import { createHandoffStore, planOf } from "./HandoffDialog.store.ts";
import { problemText, type Account, type HandoffPlan, type HandoffResult } from "./model.ts";
import { useRead } from "../../components/read.tsx";
import { DialogNotice, NoticeInDialog, SaveButton, useSaveIntent } from "../../components/save/parts.tsx";
import { useLocalStore, useStore } from "../../components/store.ts";

type Seat = { accountId: string; displayName: string; role: string };

export function useHandoff(onMoved: (r: HandoffResult, plan: HandoffPlan) => void) {
	const store = useLocalStore(() => createHandoffStore({ loadPlan }));
	const { open, from, plan, selected, to, toError, result, actions } = useStore(store, (s) => s);
	const lane = useSaveIntent({ explain: problemText });

	const p = planOf({ plan });
	const chosen = p ? p.duties.filter((d) => selected.has(d.taskId)) : [];
	const recipient = p?.recipients.find((r) => r.accountId === to);

	async function submit() {
		if (!p) return;
		if (!recipient) return actions.refuse("Choose who takes these follow-ups.");
		actions.refuse(null);
		const input = {
			fromAccountId: p.from.accountId,
			toAccountId: recipient.accountId,
			items: chosen.slice(0, HANDOFF_LIMIT).map((d) => ({ taskId: d.taskId, expectedRevision: d.revision })),
		};
		await lane.save({
			what: `Moving ${input.items.length} follow-up${input.items.length === 1 ? "" : "s"}`,
			send: (key) => executeHandoff(key, input),
			ok: (value) => {
				actions.settle(value);
				onMoved(value, p);
			},
			refused: async (code) => {
				if (code === "conflict" || code === "handoff_target_ineligible") await actions.preview(p.from.accountId, true);
			},
		});
	}
	function start(account?: string) {
		actions.show(true);
		if (account === undefined || lane.notice || lane.wait) return;
		actions.settle(null);
		actions.choose(account);
		void actions.preview(account, false);
	}
	function close() {
		actions.show(false);
		if (lane.notice || lane.wait) return;
		actions.reset();
	}
	return {
		open,
		from,
		setFrom: actions.choose,
		plan,
		p,
		selected,
		setSelected: actions.select,
		to,
		setTo: actions.give,
		toError,
		result,
		setResult: actions.settle,
		lane,
		chosen,
		preview: actions.preview,
		submit,
		start,
		close,
	};
}
export type Handoff = ReturnType<typeof useHandoff>;

export function HandoffDialog({
	h,
	former,
	onClose,
	returnFocus,
}: {
	h: Handoff;
	returnFocus?: (e: Event) => void;
	former: readonly (Account & { open: number })[];
	onClose: () => void;
}) {
	const { from, setFrom, plan, p, selected, setSelected, to, setTo, toError, result, setResult, lane } = h;
	const { chosen, preview, submit } = h;
	const seats = useRead(seatList).value ?? null;
	const sourceName =
		p?.from.displayName ??
		(seats?.status === "ok" ? (seats.value.items.find((s) => s.accountId === from)?.displayName ?? null) : null);
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
