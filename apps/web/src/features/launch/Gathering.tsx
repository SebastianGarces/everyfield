"use client";

import { checkGathering, checkNote, type GatheringOffer, type Plan } from "@everyfield/contracts/launch";
import { Alert02Icon, Flag02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	CalloutLabel,
	CalloutText,
	Card,
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
	InsightCard,
	InsightCount,
	InsightFooter,
	InsightPill,
	InsightText,
	InsightTitle,
	InsightTop,
	Input,
	Textarea,
	useToast,
} from "@everyfield/ui/controls";
import { useState } from "react";
import type { chooseGatheringPath, readGatheringOffers, saveGathering } from "./actions.ts";
import {
	GATHERING_MESSAGE,
	longDate,
	NOTE_MESSAGE,
	offerLabel,
	refusalMessage,
	sent,
	type Outcome,
	type requestKeys,
} from "./model.ts";

// How the church ends its gathering phase (T-296): Launch Sunday, or a milestone its network or sending church offers.
// The Owner or Admin picks, records the day it was reached, corrects or clears it. Nothing here moves the phase,
// changes the launch date or creates a task; a Member reads the path and the record only.

type Keys = ReturnType<typeof requestKeys>;
type Milestone = Extract<Plan["path"], { kind: "milestone" }>;
type Mode = "record" | "correct" | "clear";
type Draft = { mode: Mode; date: string; note: string; reason: string; error: string | null };
export type Offers = Outcome<GatheringOffer[]> | null;
/** The server actions these cards call; the Launch plan passes the real ones. */
export type GatheringActions = {
	choose: typeof chooseGatheringPath;
	save: typeof saveGathering;
	offers: typeof readGatheringOffers;
};

/** "Oct 11, 2026": a church-local date. */
const dayText = (date: string) =>
	new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(
		new Date(`${date}T12:00:00Z`),
	);

/** Switch the church's path, answering with the plan as saved; a refusal says why and changes nothing. */
function useSwitch(
	act: GatheringActions,
	plan: Plan,
	keys: Keys,
	onPlan: (p: Plan) => void,
	onOffers: (o: Offers) => void,
) {
	const toast = useToast();
	const [busy, setBusy] = useState<string | null>(null);
	async function choose(organizationId: string | null) {
		const input = organizationId ? { path: "milestone", organizationId } : { path: "launch_sunday" };
		const intent = ["path", plan.revision, organizationId] as const;
		setBusy(organizationId ?? "launch_sunday");
		const r = await sent(() => act.choose(keys.keyFor(intent), plan.revision, input));
		setBusy(null);
		if (r.status !== "lost") keys.settle(intent);
		if (r.status === "ok") return onPlan(r.value.plan);
		toast({ message: refusalMessage(r), tone: "error" });
		if (r.status === "refused" && r.error.code === "gathering_unavailable") onOffers(await sent(act.offers));
	}
	return { busy, choose };
}

/**
 * The milestone the church uses, in the place of Launch Sunday's date and countdown: who chose it, what it means, and
 * whether it was reached. A milestone no longer offered says so, and the church can go back to Launch Sunday.
 */
export function GatheringCard({
	act,
	plan,
	path,
	admin,
	keys,
	onPlan,
	onOffers,
}: {
	act: GatheringActions;
	plan: Plan;
	path: Milestone;
	admin: boolean;
	keys: Keys;
	onPlan: (p: Plan) => void;
	onOffers: (o: Offers) => void;
}) {
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saving, setSaving] = useState(false);
	const { busy, choose } = useSwitch(act, plan, keys, onPlan, onOffers);
	const r = path.reached;
	const by = path.organizationName;
	const gone = !path.offered;
	const name = r?.name ?? path.offered?.name ?? null;
	const open = (mode: Mode) =>
		setDraft({
			mode,
			date: mode === "record" ? plan.today : (r?.date ?? ""),
			note: r?.note ?? "",
			reason: "",
			error: null,
		});

	async function submit(d: Draft) {
		if (d.mode !== "clear") {
			const v = checkGathering({ date: d.date, note: d.note }, plan.today);
			if (!v.ok) return setDraft({ ...d, error: GATHERING_MESSAGE[v.problem] });
		}
		if (d.mode !== "record") {
			const reason = checkNote(d.reason, true);
			if (!reason.ok) return setDraft({ ...d, error: NOTE_MESSAGE[reason.problem] });
		}
		const intent = ["gathering", d.mode, plan.revision, d.date, d.note, d.reason] as const;
		setSaving(true);
		const res = await sent(() =>
			act.save(keys.keyFor(intent), plan.revision, d.mode, { date: d.date, note: d.note, reason: d.reason }),
		);
		setSaving(false);
		if (res.status !== "lost") keys.settle(intent);
		if (res.status === "ok") {
			setDraft(null);
			return onPlan(res.value.plan);
		}
		setDraft({ ...d, error: refusalMessage(res) });
	}

	const title = r
		? `${r.name} — reached ${dayText(r.date)}`
		: gone
			? "Milestone no longer offered"
			: `${name} not reached yet`;
	return (
		<InsightCard tone="field" aria-labelledby="gathering-milestone">
			<InsightTop>
				<InsightPill icon={Flag02Icon}>Gathering milestone</InsightPill>
				{r ? <InsightCount>{longDate(r.date)}</InsightCount> : null}
			</InsightTop>
			<InsightTitle id="gathering-milestone" className="mt-[26px]">
				{title}
			</InsightTitle>
			<InsightText>
				{gone && !r
					? `No longer offered by ${by ?? "the organization that chose it"}. ${admin ? "Go back to Launch Sunday, or choose another milestone if one is offered." : "An Owner or Admin can go back to Launch Sunday."}`
					: `${name ? `Used instead of Launch Sunday, chosen by ${by ?? "an organization no longer connected"}.` : ""}${path.offered?.description ? ` ${path.offered.description}` : ""}`}
			</InsightText>
			{r?.note ? <InsightText className="mt-2 whitespace-pre-line">{r.note}</InsightText> : null}
			{r && gone ? (
				<InsightText className="mt-2">
					No longer offered by {by ?? "the organization that chose it"}. The record stays.
				</InsightText>
			) : null}
			{admin ? (
				<InsightFooter>
					{r ? (
						<>
							<Button variant="light" onClick={() => open("correct")}>
								Correct
							</Button>
							<Button variant="light" onClick={() => open("clear")}>
								Clear record
							</Button>
							<span className="text-sm text-[var(--on-2)]">To go back to Launch Sunday, clear the record first.</span>
						</>
					) : (
						<>
							{!gone ? (
								<Button variant="light" onClick={() => open("record")}>
									Record reached
								</Button>
							) : null}
							<Button variant="light" disabled={busy !== null} onClick={() => choose(null)}>
								{busy ? "Switching" : "Use Launch Sunday instead"}
							</Button>
						</>
					)}
				</InsightFooter>
			) : null}
			{draft && name ? (
				<GatheringDialog draft={draft} name={name} saving={saving} onChange={setDraft} onSubmit={submit} />
			) : null}
		</InsightCard>
	);
}

/**
 * The milestones the church's network or sending church offer instead of Launch Sunday, each labelled with who chose
 * it. Shown to an Owner or Admin while there is one to switch to; when the offers can't load it says so, and the
 * church's current path stays shown above it.
 */
export function GatheringChoice({
	act,
	plan,
	offers,
	keys,
	onPlan,
	onOffers,
}: {
	act: GatheringActions;
	plan: Plan;
	offers: Offers;
	keys: Keys;
	onPlan: (p: Plan) => void;
	onOffers: (o: Offers) => void;
}) {
	const { busy, choose } = useSwitch(act, plan, keys, onPlan, onOffers);
	if (!offers) return null;
	if (offers.status !== "ok")
		return (
			<Card variant="callout" tone="amber" className="mt-5" role="status">
				<CalloutLabel tone="amber" icon={Alert02Icon}>
					Gathering milestones
				</CalloutLabel>
				<CalloutText className="text-md">
					The milestones your network or sending church offer could not load. Your church&rsquo;s path is shown as it is.
					Reload the page in a moment to see them.
				</CalloutText>
			</Card>
		);
	const current = plan.path.kind === "milestone" ? plan.path : null;
	const others = offers.value.filter((o) => o.organizationId !== current?.organizationId);
	// A church that recorded Launch Sunday keeps it; a reached milestone is cleared before any switch.
	if (!others.length || plan.outcome || current?.reached) return null;
	return (
		<Card className="mt-5">
			<CardHeader>
				<CardHeading>
					<CardTitle>{current ? "Other milestones offered" : "End the gathering phase another way"}</CardTitle>
					<CardDescription>
						{current
							? "Switch to another milestone your church's organizations offer. Nothing else changes."
							: "Use a milestone your network or sending church offers instead of Launch Sunday. The launch date, tasks and phase stay as they are, so you can switch back."}
					</CardDescription>
				</CardHeading>
			</CardHeader>
			<ul className="flex flex-col">
				{others.map((o) => (
					<li
						key={o.organizationId}
						className="flex items-center gap-4 border-t border-line py-3.5 first:border-t-0 first:pt-0 max-app-sm:flex-col max-app-sm:items-start"
					>
						<div className="min-w-0 flex-1">
							<p className="font-medium text-ink">{offerLabel(o.name, o.organizationName)}</p>
							{o.description ? <p className="mt-0.5 text-sm whitespace-pre-line text-text-2">{o.description}</p> : null}
						</div>
						<Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => choose(o.organizationId)}>
							{busy === o.organizationId ? "Switching" : "Use this milestone"}
						</Button>
					</li>
				))}
			</ul>
		</Card>
	);
}

function GatheringDialog({
	draft,
	name,
	saving,
	onChange,
	onSubmit,
}: {
	draft: Draft;
	name: string;
	saving: boolean;
	onChange: (d: Draft | null) => void;
	onSubmit: (d: Draft) => void;
}) {
	const copy = {
		record: {
			title: `Record ${name} reached`,
			description: "The church's phase stays as it is. You move it yourself when you are ready.",
			submit: "Record",
		},
		correct: {
			title: `Correct ${name}`,
			description: "The Launch history keeps the earlier date and your reason.",
			submit: "Save correction",
		},
		clear: {
			title: `Clear ${name} record`,
			description: "Takes back the reached date and note. The Launch history keeps them and your reason.",
			submit: "Clear record",
		},
	}[draft.mode];
	const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch, error: null });
	return (
		<Dialog open onOpenChange={(next) => (next ? null : onChange(null))}>
			<DialogContent size="sm">
				<DialogHeader title={copy.title} description={copy.description} />
				<form
					className="contents"
					onSubmit={(event) => {
						event.preventDefault();
						onSubmit(draft);
					}}
				>
					<DialogBody className="flex flex-col gap-4">
						{draft.mode !== "clear" ? (
							<>
								<Field label="Reached on">
									<Input type="date" required value={draft.date} onChange={(e) => set({ date: e.target.value })} />
								</Field>
								<Field
									label="Note (optional)"
									hint="Up to 2,000 characters."
									error={draft.mode === "record" ? draft.error : null}
								>
									<Textarea rows={3} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
								</Field>
							</>
						) : null}
						{draft.mode !== "record" ? (
							<Field label="Reason" hint="Up to 2,000 characters. It stays in the Launch history." error={draft.error}>
								<Textarea rows={3} value={draft.reason} onChange={(e) => set({ reason: e.target.value })} />
							</Field>
						) : null}
					</DialogBody>
					<DialogFooter>
						<Button type="button" variant="secondary" onClick={() => onChange(null)}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" disabled={saving}>
							{saving ? "Saving" : copy.submit}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
