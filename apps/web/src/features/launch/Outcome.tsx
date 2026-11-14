"use client";

import { checkNote, checkOutcome, GUEST_NAME_MAX, type GuestMatch, type Plan } from "@everyfield/contracts/launch";
import { Add01Icon, PencilEdit02Icon, UserAdd01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardActions,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	Textarea,
	useToast,
} from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { addGuest, correctOutcome, recordOutcome, suggestGuests } from "./actions.ts";
import {
	countText,
	longDate,
	NOTE_MESSAGE,
	OUTCOME_MESSAGE,
	parseCount,
	refusalMessage,
	sent,
	type requestKeys,
} from "./model.ts";

type Keys = ReturnType<typeof requestKeys>;
type Draft = {
	mode: "record" | "correct";
	actualDate: string;
	attendance: string;
	decisions: string;
	note: string;
	reason: string;
	error: string | null;
};

/**
 * What happened on Launch Sunday (WP-046, LCH-006/007): the actual date beside the planned one, attendance, decisions,
 * the note and the guests named. Owners and Admins record and correct it; a Member reads the outcome and the guest
 * count. Recording moves no phase, creates no meeting and sends nothing.
 */
export function OutcomeCard({
	plan,
	admin,
	keys,
	onPlan,
}: {
	plan: Plan;
	admin: boolean;
	keys: Keys;
	onPlan: (p: Plan) => void;
}) {
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saving, setSaving] = useState(false);
	const o = plan.outcome;
	const planned = plan.launch?.targetDate ?? null;

	const open = (mode: Draft["mode"]) =>
		setDraft({
			mode,
			actualDate: o?.actualDate ?? "",
			attendance: o?.attendance === null || !o ? "" : String(o.attendance),
			decisions: o?.decisions === null || !o ? "" : String(o.decisions),
			note: o?.note ?? "",
			reason: "",
			error: null,
		});

	async function submit(d: Draft) {
		const attendance = parseCount(d.attendance);
		const decisions = parseCount(d.decisions);
		if (!d.actualDate) return setDraft({ ...d, error: "Choose the date Launch Sunday was held." });
		if (!attendance.ok || !decisions.ok) return setDraft({ ...d, error: OUTCOME_MESSAGE.count_out_of_range });
		const input = {
			actualDate: d.actualDate,
			attendance: attendance.value,
			decisions: decisions.value,
			note: d.note.trim() ? d.note : null,
		};
		const checked = checkOutcome(input, plan.today);
		if (!checked.ok) return setDraft({ ...d, error: OUTCOME_MESSAGE[checked.problem] });
		if (d.mode === "correct") {
			const reason = checkNote(d.reason, true);
			if (!reason.ok) return setDraft({ ...d, error: NOTE_MESSAGE[reason.problem] });
		}
		const intent = [d.mode, plan.revision, input, d.reason] as const;
		setSaving(true);
		const r = await sent(() =>
			d.mode === "record"
				? recordOutcome(keys.keyFor(intent), plan.revision, input)
				: correctOutcome(keys.keyFor(intent), plan.revision, { ...input, reason: d.reason }),
		);
		setSaving(false);
		if (r.status !== "lost") keys.settle(intent);
		if (r.status === "ok") {
			setDraft(null);
			return onPlan(r.value.plan);
		}
		setDraft({ ...d, error: refusalMessage(r) });
	}

	return (
		<Card className="mt-5" aria-labelledby="launch-outcome">
			<CardHeader>
				<CardHeading>
					<CardTitle id="launch-outcome">Launch Sunday</CardTitle>
					<CardDescription>
						{o
							? "What actually happened. The planned date stays as it was."
							: "What actually happened, once it has. A passed date or finished milestones never record it for you."}
					</CardDescription>
				</CardHeading>
				{admin ? (
					<CardActions>
						{o ? (
							<Button variant="secondary" size="sm" onClick={() => open("correct")}>
								<Icon icon={PencilEdit02Icon} size={16} />
								Correct
							</Button>
						) : (
							<Button variant="primary" size="sm" onClick={() => open("record")}>
								<Icon icon={Add01Icon} size={16} />
								Record Launch Sunday
							</Button>
						)}
					</CardActions>
				) : null}
			</CardHeader>
			{o ? (
				<>
					<dl className="grid grid-cols-5 gap-x-6 gap-y-4 max-app-md:grid-cols-3 max-app-sm:grid-cols-2">
						<Fact label="Held" value={longDate(o.actualDate)} />
						<Fact label="Planned" value={planned ? longDate(planned) : "No date"} muted />
						<Fact label="Attendance" value={countText(o.attendance)} muted={o.attendance === null} />
						<Fact label="Decisions" value={countText(o.decisions)} muted={o.decisions === null} />
						<Fact label="Guests named" value={countText(plan.guests.count)} />
					</dl>
					{o.note ? <p className="mt-4 text-sm break-words whitespace-pre-line text-ink-2">{o.note}</p> : null}
					{o.attendance !== null && o.attendance > plan.guests.count ? (
						<p className="mt-3 text-xs text-text-3">
							Attendance counts everyone who came. Only the guests you name become People.
						</p>
					) : null}
					{admin && plan.guests.named ? <Guests plan={plan} keys={keys} onPlan={onPlan} /> : null}
				</>
			) : (
				<p className="text-sm text-text-2">
					{admin
						? "After Launch Sunday, record the date it was held, how many came, decisions and a note. Then name the guests you can."
						: "Nothing is recorded yet. An Owner or Admin records Launch Sunday after it happens."}
				</p>
			)}
			{draft ? (
				<OutcomeDialog draft={draft} saving={saving} today={plan.today} onChange={setDraft} onSubmit={submit} />
			) : null}
		</Card>
	);
}

function Fact({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
	return (
		<div className="min-w-0">
			<dt className="text-sm text-text-3">{label}</dt>
			<dd className={muted ? "mt-1 text-text-2" : "mt-1 font-semibold text-ink"}>{value}</dd>
		</div>
	);
}

function OutcomeDialog({
	draft,
	saving,
	today,
	onChange,
	onSubmit,
}: {
	draft: Draft;
	saving: boolean;
	today: string;
	onChange: (d: Draft | null) => void;
	onSubmit: (d: Draft) => void;
}) {
	const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch, error: null });
	const correcting = draft.mode === "correct";
	return (
		<Dialog open onOpenChange={(next) => (next ? null : onChange(null))}>
			<DialogContent size="sm">
				<DialogHeader
					title={correcting ? "Correct Launch Sunday" : "Record Launch Sunday"}
					description={
						correcting
							? "The values you change stay in Launch history with your reason. The phase stays as it is."
							: "Leave a count empty if you didn't count it. A 0 is recorded as 0."
					}
				/>
				<form
					className="contents"
					noValidate
					onSubmit={(event) => {
						event.preventDefault();
						onSubmit(draft);
					}}
				>
					<DialogBody className="flex flex-col gap-4">
						<Field label="Date held">
							<Input
								type="date"
								required
								max={today}
								value={draft.actualDate}
								onChange={(e) => set({ actualDate: e.target.value })}
							/>
						</Field>
						<div className="grid grid-cols-2 gap-4">
							<Field label="Attendance" optional>
								<Input
									inputMode="numeric"
									value={draft.attendance}
									onChange={(e) => set({ attendance: e.target.value })}
								/>
							</Field>
							<Field label="Decisions" optional>
								<Input
									inputMode="numeric"
									value={draft.decisions}
									onChange={(e) => set({ decisions: e.target.value })}
								/>
							</Field>
						</div>
						<Field label="Note" optional hint="Up to 10,000 characters.">
							<Textarea rows={3} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
						</Field>
						{correcting ? (
							<Field label="Reason" hint="Up to 2,000 characters. It stays in Launch history.">
								<Textarea rows={2} value={draft.reason} onChange={(e) => set({ reason: e.target.value })} />
							</Field>
						) : null}
						{draft.error ? (
							<p role="alert" className="text-sm text-red-700">
								{draft.error}
							</p>
						) : null}
					</DialogBody>
					<DialogFooter>
						<Button type="button" variant="secondary" onClick={() => onChange(null)}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" disabled={saving}>
							{saving ? "Saving" : correcting ? "Save correction" : "Record"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * The guests a planter names (LCH-007). Typing shows People of the church with a matching name; picking one links that
 * Person. "Add as a new person" creates a Person with only the typed name. A name alone never links anyone.
 */
function Guests({ plan, keys, onPlan }: { plan: Plan; keys: Keys; onPlan: (p: Plan) => void }) {
	const toast = useToast();
	const [name, setName] = useState("");
	const [matches, setMatches] = useState<GuestMatch[]>([]);
	const [busy, setBusy] = useState(false);
	const asked = useRef(0);
	const typed = name.trim();

	useEffect(() => {
		if (typed.length < 2) return;
		const ask = ++asked.current;
		const timer = setTimeout(async () => {
			const r = await sent(() => suggestGuests(typed));
			if (ask === asked.current && r.status === "ok") setMatches(r.value);
		}, 200);
		return () => clearTimeout(timer);
	}, [typed]);

	async function add(input: { personId: string } | { displayName: string }) {
		const intent = ["guest", input] as const;
		setBusy(true);
		const r = await sent(() => addGuest(keys.keyFor(intent), input));
		setBusy(false);
		if (r.status !== "lost") keys.settle(intent);
		if (r.status === "ok") {
			setName("");
			setMatches([]);
			if (r.value.outcome === "noop") toast({ message: "Already named as a Launch Sunday guest.", tone: "info" });
			return onPlan(r.value.plan);
		}
		toast({ message: refusalMessage(r), tone: "error" });
	}

	const named = plan.guests.named ?? [];
	// Matches for a name of two letters or more; a shorter one shows none.
	const shown = typed.length < 2 ? [] : matches;
	return (
		<section aria-labelledby="launch-guests" className="mt-6 border-t border-line pt-5">
			<h3 id="launch-guests" className="text-sm font-semibold text-ink">
				Guests you can name
			</h3>
			<p className="mt-1 text-sm text-text-2">
				Each one becomes a Person in People, linked as a Launch Sunday guest. Only a name is needed.
			</p>
			<form
				className="mt-3 flex items-start gap-2 max-app-sm:flex-col max-app-sm:items-stretch"
				onSubmit={(e) => {
					e.preventDefault();
					if (typed) void add({ displayName: typed });
				}}
			>
				<Field label="Guest name" className="min-w-0 flex-1">
					<Input
						value={name}
						maxLength={GUEST_NAME_MAX}
						autoComplete="off"
						placeholder="First name is enough"
						onChange={(e) => setName(e.target.value)}
					/>
				</Field>
				<Button type="submit" variant="secondary" className="mt-[26px] max-app-sm:mt-0" disabled={!typed || busy}>
					<Icon icon={UserAdd01Icon} size={16} />
					Add as a new person
				</Button>
			</form>
			{shown.length ? (
				<div className="mt-3 rounded-md bg-surface-2 p-3">
					<p className="text-xs text-text-3">Already in People? Pick them instead of adding someone new.</p>
					<ul className="mt-2 flex flex-col gap-1.5">
						{shown.map((m) => (
							<li key={m.personId} className="flex items-center justify-between gap-3">
								<span className="min-w-0 text-sm">
									<span className="font-medium text-ink">{m.displayName}</span>
									{m.detail ? <span className="text-text-3"> · {m.detail}</span> : null}
								</span>
								{m.alreadyGuest ? (
									<span className="text-xs text-text-3">Already a guest</span>
								) : (
									<Button variant="ghost" size="sm" disabled={busy} onClick={() => add({ personId: m.personId })}>
										Pick
									</Button>
								)}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{named.length ? (
				<ul className="mt-4 flex flex-wrap gap-2">
					{named.map((g) => (
						<li key={g.guestId}>
							<Link
								href={`/people/${encodeURIComponent(g.personId)}`}
								className="inline-flex cursor-pointer items-center rounded-pill bg-surface-2 px-3 py-1 text-sm text-ink hover:underline"
							>
								{g.displayName}
							</Link>
						</li>
					))}
				</ul>
			) : (
				<p className="mt-4 text-sm text-text-3">No guests named yet.</p>
			)}
		</section>
	);
}
