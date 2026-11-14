"use client";

import {
	ANSWER_MAX,
	checkDebrief,
	checkSummary,
	GUEST_QUESTION,
	SUMMARY_MAX,
	type DebriefAnswers,
	type Plan,
} from "@everyfield/contracts/launch";
import {
	Button,
	Card,
	CardActions,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Field,
	Input,
	Radio,
	RadioGroup,
	Textarea,
	useToast,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { saveDebrief, saveSummary } from "./actions.ts";
import {
	countText,
	DEBRIEF_MESSAGE,
	EVIDENCE_TEXT,
	instantDate,
	longDate,
	parseCount,
	refusalMessage,
	sent,
	SUMMARY_MESSAGE,
	type requestKeys,
} from "./model.ts";

type Keys = ReturnType<typeof requestKeys>;
type Written = "wentWell" | "toChange" | "operations" | "followUpPlan" | "supportNeeded";
/** The six areas, in order. The first is the recorded Launch Sunday, never a second copy of it. */
const AREAS: { key: Written; label: string }[] = [
	{ key: "wentWell", label: "What went well" },
	{ key: "toChange", label: "What to change" },
	{ key: "operations", label: "Welcoming, children, worship and logistics" },
	{ key: "followUpPlan", label: "Guest follow-up plan" },
	{ key: "supportNeeded", label: "Support needed from sending churches and networks" },
];
type Form = Record<Written, string> & { missingNames: "yes" | "no" | null; missingCount: string };
const formOf = (a: DebriefAnswers | null): Form => ({
	wentWell: a?.wentWell ?? "",
	toChange: a?.toChange ?? "",
	operations: a?.operations ?? "",
	followUpPlan: a?.followUpPlan ?? "",
	supportNeeded: a?.supportNeeded ?? "",
	missingNames: a?.missingNames ?? null,
	missingCount: a?.missingCount === null || !a ? "" : String(a.missingCount),
});
function answersOf(f: Form): DebriefAnswers | null {
	const count = parseCount(f.missingCount);
	if (!count.ok) return null;
	const blank = (v: string) => (v.trim() ? v : null);
	return {
		wentWell: blank(f.wentWell),
		toChange: blank(f.toChange),
		operations: blank(f.operations),
		followUpPlan: blank(f.followUpPlan),
		supportNeeded: blank(f.supportNeeded),
		missingNames: f.missingNames,
		missingCount: f.missingNames === "yes" ? count.value : null,
	};
}

/**
 * After Launch Sunday (LCH-010): the two evidence-governed milestones and the debrief. "Guest names entered" and
 * "Debrief done" follow the latest submitted debrief only; they have no checkbox. Owners and Admins write the debrief;
 * every seat sees the two milestones.
 */
export function DebriefCard({
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
	const e = plan.evidence;
	const d = plan.debrief;
	const guests = EVIDENCE_TEXT[e.guestNamesEntered.status];
	const done = EVIDENCE_TEXT[e.debriefDone.status];
	const [editing, setEditing] = useState(() => !d?.submitted || d.draft !== null);
	return (
		<Card className="mt-5" aria-labelledby="launch-debrief">
			<CardHeader>
				<CardHeading>
					<CardTitle id="launch-debrief">After Launch Sunday</CardTitle>
					<CardDescription>
						Two milestones the submitted debrief decides. Nobody checks them off by hand.
					</CardDescription>
				</CardHeading>
				{admin && d?.submitted && !editing ? (
					<CardActions>
						<Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
							Correct debrief
						</Button>
					</CardActions>
				) : null}
			</CardHeader>
			<ul className="grid grid-cols-2 gap-2.5 max-app-sm:grid-cols-1">
				<li className="flex items-center justify-between gap-3 rounded-md bg-surface-2 px-3.5 py-3">
					<span className="min-w-0">
						<span className="block text-sm text-ink-2">Guest names entered</span>
						<span className="mt-0.5 block text-xs text-text-3">
							{e.guestNamesEntered.status === "not_met"
								? `${countText(e.guestNamesEntered.remaining)} remaining, as the debrief says`
								: e.guestNamesEntered.status === "met"
									? "The debrief says every guest is in People"
									: "Waiting for a submitted debrief"}
						</span>
					</span>
					<StatusBadge size="sm" status={guests.tone} className="shrink-0">
						{guests.label}
					</StatusBadge>
				</li>
				<li className="flex items-center justify-between gap-3 rounded-md bg-surface-2 px-3.5 py-3">
					<span className="min-w-0">
						<span className="block text-sm text-ink-2">Debrief done</span>
						<span className="mt-0.5 block text-xs text-text-3">
							{e.submittedAt
								? `Submitted ${instantDate(e.submittedAt, plan.timeZone)}`
								: "Waiting for a submitted debrief"}
						</span>
					</span>
					<StatusBadge size="sm" status={done.tone} className="shrink-0">
						{done.label}
					</StatusBadge>
				</li>
			</ul>
			{admin && d && plan.outcome ? (
				editing ? (
					<DebriefForm
						key={d.submitted?.id ?? "first"}
						plan={plan}
						keys={keys}
						onPlan={onPlan}
						onSubmitted={() => setEditing(false)}
						onCancel={d.submitted && !d.draft ? () => setEditing(false) : null}
					/>
				) : d.submitted ? (
					<Submitted plan={plan} />
				) : null
			) : null}
		</Card>
	);
}

function Submitted({ plan }: { plan: Plan }) {
	const s = plan.debrief!.submitted!;
	return (
		<section aria-label="Submitted debrief" className="mt-6 border-t border-line pt-5">
			<p className="text-sm text-ink">
				<b className="font-semibold">Submitted</b> {instantDate(s.submittedAt!, plan.timeZone)}
				{s.submittedBy ? ` by ${s.submittedBy.displayName}` : " by a former account"}
				{plan.debrief!.submissions > 1 ? ` · version ${plan.debrief!.submissions}` : ""}
			</p>
			<dl className="mt-4 flex flex-col gap-4">
				{AREAS.map((a) => (
					<div key={a.key}>
						<dt className="text-sm text-text-3">{a.label}</dt>
						<dd className="mt-1 text-sm break-words whitespace-pre-line text-ink-2">
							{s.answers[a.key] ?? <span className="text-text-3">No answer</span>}
						</dd>
					</div>
				))}
				<div>
					<dt className="text-sm text-text-3">{GUEST_QUESTION}</dt>
					<dd className="mt-1 text-sm text-ink-2">
						{s.answers.missingNames === "yes" ? `Yes, ${countText(s.answers.missingCount)}` : "No"}
					</dd>
				</div>
			</dl>
		</section>
	);
}

/**
 * The six-area debrief, saved as a draft as the planter types (and when they press Save draft), so leaving the page
 * keeps it. Submitting needs only the guest answer; no area has a minimum length.
 */
function DebriefForm({
	plan,
	keys,
	onPlan,
	onSubmitted,
	onCancel,
}: {
	plan: Plan;
	keys: Keys;
	onPlan: (p: Plan) => void;
	onSubmitted: () => void;
	onCancel: (() => void) | null;
}) {
	const toast = useToast();
	const d = plan.debrief!;
	const [initial] = useState(() => formOf(d.draft?.answers ?? d.submitted?.answers ?? null));
	const [form, setForm] = useState<Form>(initial);
	const [status, setStatus] = useState<string | null>(
		d.draft ? `Draft saved ${instantDate(d.draft.savedAt, plan.timeZone)}` : null,
	);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// The draft the server holds, so each save names it and a second tab's older draft is refused, never overwritten.
	const held = useRef(d.draft ? { id: d.draft.id, revision: d.draft.revision } : null);
	const dirty = useRef(false);
	const inFlight = useRef(false);
	// The form as typed, for a save that runs after the render that changed it.
	const latest = useRef(initial);
	const o = plan.outcome!;

	async function save(submit: boolean) {
		const answers = answersOf(latest.current);
		if (!answers) return setError(DEBRIEF_MESSAGE.count_out_of_range);
		const checked = checkDebrief(answers, submit);
		if (!checked.ok) {
			if (submit) setError(DEBRIEF_MESSAGE[checked.problem]);
			return;
		}
		dirty.current = false;
		const fence = held.current;
		const intent = ["debrief", submit, fence, checked.answers] as const;
		setBusy(true);
		inFlight.current = true;
		if (!submit) setStatus("Saving draft");
		const r = await sent(() =>
			saveDebrief(keys.keyFor(intent), fence?.revision ?? "0", fence?.id ?? null, checked.answers, submit),
		);
		inFlight.current = false;
		setBusy(false);
		if (r.status !== "lost") keys.settle(intent);
		if (r.status === "ok") {
			const draft = r.value.plan.debrief?.draft ?? null;
			held.current = draft ? { id: draft.id, revision: draft.revision } : null;
			setError(null);
			onPlan(r.value.plan);
			if (submit) {
				toast({ message: "Debrief submitted.", tone: "success" });
				return onSubmitted();
			}
			setStatus(draft ? `Draft saved ${instantDate(draft.savedAt, plan.timeZone)}` : null);
			if (dirty.current) void save(false);
			return;
		}
		dirty.current = true;
		setStatus(null);
		setError(refusalMessage(r));
	}

	// Save a draft a moment after the planter stops typing. A save already on its way saves again when it lands.
	const autosave = useEffectEvent(() => {
		if (dirty.current && !inFlight.current) void save(false);
	});
	useEffect(() => {
		const timer = setTimeout(autosave, 900);
		return () => clearTimeout(timer);
	}, [form]);

	const set = (patch: Partial<Form>) => {
		const next = { ...latest.current, ...patch };
		latest.current = next;
		dirty.current = true;
		setError(null);
		setForm(next);
	};

	return (
		<form
			className="mt-6 flex flex-col gap-5 border-t border-line pt-5"
			onSubmit={(e) => {
				e.preventDefault();
				void save(true);
			}}
		>
			<div>
				<h3 className="text-sm font-semibold text-ink">Debrief</h3>
				<p className="mt-1 text-sm text-text-2">
					{d.submitted
						? "A correction. The submitted version stays in force until you submit this one."
						: "Six short areas. Write as much or as little as helps."}
				</p>
			</div>
			<section aria-labelledby="area-actual">
				<h4 id="area-actual" className="text-sm font-medium text-ink-2">
					Actual date and attendance
				</h4>
				<p className="mt-1 text-sm text-ink">
					Held {longDate(o.actualDate)} · {countText(o.attendance)} attended · {countText(o.decisions)} decisions ·{" "}
					{countText(plan.guests.count)} guests named
				</p>
				<p className="mt-0.5 text-xs text-text-3">From Launch Sunday above. Correct them there.</p>
			</section>
			{AREAS.map((a) => (
				<Field key={a.key} label={a.label} optional>
					<Textarea
						rows={3}
						maxLength={ANSWER_MAX}
						value={form[a.key]}
						onChange={(e) => set({ [a.key]: e.target.value })}
					/>
				</Field>
			))}
			<fieldset className="flex flex-col gap-1">
				<legend className="text-sm font-medium text-ink-2">{GUEST_QUESTION}</legend>
				<RadioGroup
					orientation="horizontal"
					value={form.missingNames ?? ""}
					onValueChange={(v) => set({ missingNames: v === "yes" ? "yes" : "no" })}
				>
					<Radio value="yes" label="Yes" />
					<Radio value="no" label="No" />
				</RadioGroup>
				{form.missingNames === "yes" ? (
					<Field label="How many?" className="max-w-40">
						<Input
							inputMode="numeric"
							value={form.missingCount}
							onChange={(e) => set({ missingCount: e.target.value })}
						/>
					</Field>
				) : null}
			</fieldset>
			{error ? (
				<p role="alert" className="text-sm text-red-700">
					{error}
				</p>
			) : null}
			<div className="flex flex-wrap items-center gap-3">
				<Button type="submit" variant="primary" disabled={busy}>
					{d.submitted ? "Submit correction" : "Submit debrief"}
				</Button>
				<Button type="button" variant="secondary" disabled={busy} onClick={() => void save(false)}>
					Save draft
				</Button>
				{onCancel ? (
					<Button type="button" variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
				) : null}
				<span aria-live="polite" className="text-sm text-text-3">
					{status}
				</span>
			</div>
		</form>
	);
}

/**
 * The summary a planter writes for their sending church or network (REQ-KNOW-112). Nothing from the debrief is copied
 * into it. They preview the exact text and publish it as the next version; earlier versions stay listed.
 */
export function SummaryCard({ plan, keys, onPlan }: { plan: Plan; keys: Keys; onPlan: (p: Plan) => void }) {
	const toast = useToast();
	const s = plan.summary!;
	const [body, setBody] = useState(s.draft?.body ?? "");
	const [preview, setPreview] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function save(publish: boolean) {
		const checked = checkSummary(body);
		if (!checked.ok) return setError(SUMMARY_MESSAGE[checked.problem]);
		const draft = plan.summary!.draft;
		const intent = ["summary", publish, draft?.id, draft?.revision, checked.body] as const;
		setBusy(true);
		const r = await sent(() =>
			saveSummary(keys.keyFor(intent), draft?.revision ?? "0", draft?.id ?? null, checked.body, publish),
		);
		setBusy(false);
		if (r.status !== "lost") keys.settle(intent);
		if (r.status === "ok") {
			onPlan(r.value.plan);
			setError(null);
			if (publish) {
				setPreview(false);
				toast({
					message: r.value.outcome === "noop" ? "That text is already published." : "Summary published.",
					tone: r.value.outcome === "noop" ? "info" : "success",
				});
			} else toast({ message: "Summary draft saved.", tone: "success" });
			return;
		}
		setError(refusalMessage(r));
	}

	const [current, ...earlier] = s.published;
	return (
		<Card className="mt-5" aria-labelledby="launch-summary">
			<CardHeader>
				<CardHeading>
					<CardTitle id="launch-summary">Summary for your sending church or network</CardTitle>
					<CardDescription>
						Write it yourself. Nothing from the debrief is copied in. Organizations you share Plant Intelligence
						findings and Meetings with read the published version.
					</CardDescription>
				</CardHeading>
			</CardHeader>
			{preview ? (
				<section aria-label="Preview" className="flex flex-col gap-3">
					<p className="text-sm text-text-2">This is exactly what will be published.</p>
					<div className="rounded-md bg-surface-2 px-4 py-3 text-sm break-words whitespace-pre-line text-ink">
						{body.trim()}
					</div>
					{error ? (
						<p role="alert" className="text-sm text-red-700">
							{error}
						</p>
					) : null}
					<div className="flex flex-wrap gap-3">
						<Button variant="primary" disabled={busy} onClick={() => void save(true)}>
							{current ? "Publish new version" : "Publish"}
						</Button>
						<Button variant="secondary" disabled={busy} onClick={() => setPreview(false)}>
							Back to editing
						</Button>
					</div>
				</section>
			) : (
				<div className="flex flex-col gap-3">
					<Field
						label="Summary"
						hint="Up to 4,000 characters. Leave out guest names and anything private: it is published as written."
						error={error}
					>
						<Textarea
							rows={5}
							maxLength={SUMMARY_MAX}
							value={body}
							onChange={(e) => {
								setBody(e.target.value);
								setError(null);
							}}
						/>
					</Field>
					<div className="flex flex-wrap gap-3">
						<Button
							variant="primary"
							disabled={busy}
							onClick={() => {
								const checked = checkSummary(body);
								if (!checked.ok) return setError(SUMMARY_MESSAGE[checked.problem]);
								setPreview(true);
							}}
						>
							Preview
						</Button>
						<Button variant="secondary" disabled={busy} onClick={() => void save(false)}>
							Save draft
						</Button>
					</div>
				</div>
			)}
			{current ? (
				<section aria-labelledby="published-heading" className="mt-6 border-t border-line pt-5">
					<h3 id="published-heading" className="text-sm font-semibold text-ink">
						Published
					</h3>
					<ol className="mt-3 flex flex-col gap-4">
						{[current, ...earlier].map((v, i) => (
							<li key={v.id} className={i ? "opacity-75" : undefined}>
								<p className="text-xs text-text-3">
									Version {v.version} · {instantDate(v.publishedAt, plan.timeZone)}
									{v.publishedBy ? ` · ${v.publishedBy.displayName}` : ""}
									{i ? " · earlier version" : " · current"}
								</p>
								<p className="mt-1 text-sm break-words whitespace-pre-line text-ink-2">{v.body}</p>
							</li>
						))}
					</ol>
				</section>
			) : null}
		</Card>
	);
}
