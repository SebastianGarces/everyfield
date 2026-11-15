"use client";

import { ANSWER_MAX, checkSummary, GUEST_QUESTION, SUMMARY_MAX, type Plan } from "@everyfield/contracts/launch";
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
import { useCallback, useState } from "react";
import { useLocalStore, useStore } from "../../components/store.ts";
import { saveDebrief, saveSummary } from "./actions.ts";
import { createDebriefStore, type Written } from "./DebriefForm.store.ts";
import {
	countText,
	EVIDENCE_TEXT,
	instantDate,
	longDate,
	refusalMessage,
	sent,
	SUMMARY_MESSAGE,
	type requestKeys,
} from "./model.ts";

type Keys = ReturnType<typeof requestKeys>;
/** The six areas, in order. The first is the recorded Launch Sunday, never a second copy of it. */
const AREAS: { key: Written; label: string }[] = [
	{ key: "wentWell", label: "What went well" },
	{ key: "toChange", label: "What to change" },
	{ key: "operations", label: "Welcoming, children, worship and logistics" },
	{ key: "followUpPlan", label: "Guest follow-up plan" },
	{ key: "supportNeeded", label: "Support needed from sending churches and networks" },
];

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
				{s.version > 1 ? ` · version ${s.version}` : ""}
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
	const store = useLocalStore(() =>
		createDebriefStore({
			plan,
			port: {
				save: saveDebrief,
				keys,
				onPlan,
				onSubmitted: () => {
					toast({ message: "Debrief submitted.", tone: "success" });
					onSubmitted();
				},
			},
		}),
	);
	const { form, status, error, busy, actions } = useStore(store, (state) => state);
	const holdPause = useCallback((node: HTMLFormElement | null) => store.getState().actions.hold(node), [store]);
	const set = actions.edit;
	const save = actions.save;
	const o = plan.outcome!;

	return (
		<form
			ref={holdPause}
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

	const current = s.published[0];
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
						{s.published.map((v, i) => (
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
