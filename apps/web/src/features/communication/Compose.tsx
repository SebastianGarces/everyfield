"use client";

import { ArrowLeft01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button, ConfirmDialog, Field, Select } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { useEffect, useRef, useState } from "react";
import {
	readDraft,
	readMeetingContext,
	readMeetingTemplate,
	saveDraft,
	scheduleDraft,
	scheduleExisting,
	sendNow,
} from "./actions.ts";
import { bodyToTextResult, textToBody } from "./body.ts";
import {
	audienceSize,
	blankForm,
	draftPayload,
	formFrom,
	formatWhen,
	isLocked,
	listed,
	plural,
	writeReason,
	type Form,
} from "./composeModel.ts";
import { PreviewStage } from "./EmailFrame.tsx";
import { pickSampleName } from "./fields.ts";
import { MessageEditor } from "./MessageEditor.tsx";
import {
	deliveryText,
	outcomeText,
	scheduledNotSentText,
	templateBinding,
	type Handoff,
	type MeetingContext,
	type PageData,
	type Step,
	type Template,
} from "./model.ts";
import { useKeys } from "./useKeys.ts";
import { ReviewStep, type SendPlan } from "./ReviewStep.tsx";
import { useAudienceSummary, WhoStep } from "./WhoStep.tsx";

// The guided compose flow: Who, Write, Review and send. The address names the step, so Back and reload work. Moving to
// the next step saves the draft, so Review always works on a saved revision and the draft shows in history.

const STEPS: { value: Step; label: string }[] = [
	{ value: "who", label: "Who" },
	{ value: "write", label: "Write" },
	{ value: "review", label: "Review and send" },
];

/** The meeting's own local date and time, as words. The parts are not shifted by the viewer's zone. */
function meetingWhen(date: string, time: string): string {
	const [y, m, d] = date.split("-").map(Number);
	const [h, min] = time.split(":").map(Number);
	if (!y || !m || !d || h === undefined || min === undefined) return `${date}, ${time}`;
	return new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(
		new Date(y, m - 1, d, h, min),
	);
}

type Loaded = { status: "loading" } | { status: "ready" } | { status: "failed"; text: string };

export function Compose({
	data,
	id,
	step,
	handoff,
	onStep,
	onSaved,
	onLeave,
	onDone,
}: {
	data: PageData;
	id: string;
	step: Step;
	handoff: Handoff | null;
	onStep: (step: Step) => void;
	/** The draft has an id now. The address changes to it by replace. */
	onSaved: (id: string, step: Step) => void;
	onLeave: () => void;
	onDone: (messageId: string, text: string) => void;
}) {
	const keys = useKeys();
	const busy = useRef(false);
	const [form, setForm] = useState<Form>(blankForm);
	const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
	const [saved, setSaved] = useState(() => JSON.stringify(draftPayload(blankForm())));
	const [extra, setExtra] = useState<Template[]>([]);
	const [meeting, setMeeting] = useState<MeetingContext | null>(null);
	const [notes, setNotes] = useState<string[]>([]);
	const [undo, setUndo] = useState<{
		subject: string;
		text: string;
		templateKey: string;
		binding: Pick<Form, "templateId" | "templateSource">;
	} | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [plan, setPlan] = useState<SendPlan | null>(null);
	const [leaving, setLeaving] = useState(false);
	const [scheduledId, setScheduledId] = useState<string | null>(null);
	const [sample] = useState(() => pickSampleName("compose"));
	/** The id this form already holds, set the moment a save returns, before the address changes to it. */
	const heldId = useRef<string | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const { summary, failed, ready } = useAudienceSummary(form.audience);
	const templates = [
		...data.templates,
		...extra.filter((t) => !data.templates.some((d) => d.templateId === t.templateId)),
	];
	const locked = isLocked(form);

	// Open: a new message, the meeting handoff, or a saved draft.
	useEffect(() => {
		let live = true;
		const fail = (text: string) => live && setLoaded({ status: "failed", text });
		const open = async () => {
			// The address moves from "new" to the saved id after the first save. The form already holds it.
			if (id !== "new" && heldId.current === id) return;
			if (id !== "new") {
				const row = data.drafts.find((d) => d.communicationId === id);
				const draft = row ?? (await readDraft(id).then((r) => (r.status === "ok" ? r.value : null)));
				if (!draft) return fail("That message is not here. It may have been deleted.");
				if (!live) return;
				const next = formFrom(draft, data.templates);
				heldId.current = draft.communicationId;
				setForm(next);
				setSaved(JSON.stringify(draftPayload(next)));
				setLoaded({ status: "ready" });
				return;
			}
			if (!handoff) {
				setLoaded({ status: "ready" });
				return;
			}
			const context = await readMeetingContext(handoff.meeting);
			if (!live) return;
			if (context.status !== "ok") {
				setNotes(["That meeting is not available. The message has no meeting."]);
				setLoaded({ status: "ready" });
				return;
			}
			setMeeting(context.value);
			let next = { ...blankForm(), meetingId: context.value.id };
			const notesNext: string[] = [];
			if (handoff.template) {
				const found = await readMeetingTemplate(context.value.type);
				if (!live) return;
				if (found.status === "ok") {
					const t = found.value;
					setExtra([t]);
					next = {
						...next,
						subject: t.subject,
						text: bodyToTextResult(t.bodyHtml).text,
						templateKey: t.templateId,
						...templateBinding(t),
					};
				} else {
					notesNext.push(
						"No invitation template for this meeting type. Write the message, or start from another template.",
					);
				}
			}
			if (handoff.recipients === "guests") {
				const people = context.value.guests.map((g) => ({ id: g.id, displayName: g.displayName, email: null }));
				next = {
					...next,
					people,
					audience: { ...next.audience, personIds: people.map((p) => p.id) },
				};
			}
			setNotes(notesNext);
			setForm(next);
			setLoaded({ status: "ready" });
		};
		void open();
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id, handoff?.meeting]);

	// A saved draft that belongs to a meeting shows the meeting's context line.
	useEffect(() => {
		if (!form.meetingId || meeting?.id === form.meetingId) return;
		let live = true;
		void readMeetingContext(form.meetingId).then((result) => {
			if (live && result.status === "ok") setMeeting(result.value);
		});
		return () => {
			live = false;
		};
	}, [form.meetingId, meeting?.id]);

	useEffect(() => {
		heading.current?.focus();
	}, [step]);

	const payload = JSON.stringify(draftPayload(form));
	const dirty = !locked && payload !== saved;
	useEffect(() => {
		if (!dirty) return;
		const guard = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", guard);
		return () => window.removeEventListener("beforeunload", guard);
	}, [dirty]);

	const hasMeeting = form.meetingId !== null;
	const write = writeReason(form, hasMeeting);
	const eligible = summary?.eligibleRecipients ?? 0;
	const whoReason = !ready
		? "Counting who can get email."
		: eligible === 0
			? "Choose at least one person who can get email"
			: null;
	const reason = step === "who" ? whoReason : step === "write" ? (locked ? null : (write?.reason ?? null)) : null;

	const guard = async (name: string, body: () => Promise<void>) => {
		if (busy.current) return;
		busy.current = true;
		setPending(name);
		setProblem(null);
		try {
			await body();
		} finally {
			busy.current = false;
			setPending(null);
		}
	};

	/** Save through saveDraft. Returns the saved form, or null when the save was refused. */
	const persist = async (target: Step): Promise<Form | null> => {
		if (locked) return form;
		const result = await saveDraft(keys.take("save"), form.revision, draftPayload(form));
		keys.settle("save", result);
		if (result.status !== "ok") {
			setProblem(outcomeText(result));
			return null;
		}
		const draft = result.value;
		heldId.current = draft.communicationId;
		const next: Form = {
			...form,
			communicationId: draft.communicationId,
			revision: draft.revision,
			state: draft.state,
		};
		setForm(next);
		setSaved(JSON.stringify(draftPayload(next)));
		onSaved(draft.communicationId, target);
		return next;
	};

	const go = (target: Step) =>
		guard("step", async () => {
			const order = STEPS.findIndex((s) => s.value === target);
			const current = STEPS.findIndex((s) => s.value === step);
			if (order > current) {
				if (step === "who" && whoReason) return;
				if (step === "write" && !locked && write) return;
			}
			if (order === current) return;
			// A save moves the address to the draft and the step in one replace. A locked message has nothing to save.
			if (locked) onStep(target);
			else await persist(target);
		});

	const saveOnly = () =>
		guard("save", async () => {
			const next = await persist(step);
			if (next) setNotes(["Draft saved."]);
		});

	const applyTemplate = (key: string) => {
		const template = templates.find((t) => t.templateId === key);
		if (!template) return;
		const changed = form.subject.trim() !== "" || form.text.trim() !== "";
		const previous = templates.find((t) => t.templateId === form.templateKey);
		const same =
			previous &&
			previous.subject === form.subject &&
			textToBody(form.text) === textToBody(bodyToTextResult(previous.bodyHtml).text);
		setUndo(
			changed && !same
				? {
						subject: form.subject,
						text: form.text,
						templateKey: form.templateKey,
						binding: { templateId: form.templateId, templateSource: form.templateSource },
					}
				: null,
		);
		setForm((current) => ({
			...current,
			subject: template.subject,
			text: bodyToTextResult(template.bodyHtml).text,
			templateKey: template.templateId,
			...templateBinding(template),
		}));
	};

	const confirm = async () => {
		if (!plan) return;
		// Review always works on a saved revision, so the form is what the server holds.
		if (!form.communicationId || !form.revision) throw new Error("Save the message before you send it.");
		const reviewed = form.state === "reviewed";
		if (plan.kind === "now") {
			const result = await sendNow(
				{ save: keys.take("save"), schedule: keys.take("schedule"), send: keys.take("send") },
				form.revision,
				reviewed
					? { kind: "reviewed", communicationId: form.communicationId }
					: { kind: "draft", input: draftPayload(form) },
			);
			keys.settle("save", result);
			keys.settle("schedule", result);
			if (result.status !== "ok") throw new Error(outcomeText(result) ?? "The email was not sent.");
			if (result.value.report === null) {
				keys.settle("send", { status: "ok", value: null });
				setForm({
					...form,
					communicationId: result.value.communicationId,
					revision: result.value.revision,
					state: "scheduled",
				});
				setScheduledId(result.value.communicationId);
				throw new Error(scheduledNotSentText);
			}
			keys.settle("send", { status: "ok", value: null });
			onDone(result.value.communicationId, deliveryText(result.value.report));
			return;
		}
		const instant = plan.at.toISOString();
		const result = reviewed
			? await scheduleExisting(keys.take("schedule"), form.revision, form.communicationId, instant)
			: await scheduleDraft(keys.take("save"), keys.take("schedule"), form.revision, draftPayload(form), instant);
		keys.settle("save", result);
		keys.settle("schedule", result);
		if (result.status !== "ok") throw new Error(outcomeText(result) ?? "The email was not scheduled.");
		onDone(
			result.value.communicationId,
			`Scheduled for ${formatWhen(result.value.scheduledAt)}. It has not been sent.`,
		);
	};

	const names = summary?.missingEmailExclusions ?? [];
	const consequences = (when: string) => [
		`${plural(eligible, "person gets", "people get")} this email ${when}.`,
		...(names.length ? [`${listed(names)} ${names.length === 1 ? "has" : "have"} no email and will be skipped.`] : []),
		"You cannot unsend it once it leaves.",
	];

	if (loaded.status === "loading") {
		return (
			<p role="status" className="text-md text-text-2">
				Opening the message.
			</p>
		);
	}
	if (loaded.status === "failed") {
		return (
			<div className="flex flex-col items-start gap-3">
				<p role="alert" className="text-md font-medium text-magenta-600">
					{loaded.text}
				</p>
				<Button variant="secondary" onClick={onLeave}>
					Back to messages
				</Button>
			</div>
		);
	}

	const stepIndex = STEPS.findIndex((s) => s.value === step);
	const previewName = summary?.recipients[0]?.displayName ?? sample;
	const chrome = { from: data.churchName, to: previewName, subject: form.subject };

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<button
					type="button"
					onClick={() => (dirty ? setLeaving(true) : onLeave())}
					className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm text-md font-medium text-ink-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ef-focus)]"
				>
					<Icon icon={ArrowLeft01Icon} size={16} />
					Back to messages
				</button>
				<nav aria-label="Steps">
					<ol className="flex items-center gap-2">
						{STEPS.map((s, i) => (
							<li key={s.value} className="flex items-center gap-2">
								<button
									type="button"
									aria-current={s.value === step ? "step" : undefined}
									onClick={() => void go(s.value)}
									className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md px-3 text-md font-medium text-text-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ef-focus)] aria-[current=step]:bg-surface-2 aria-[current=step]:text-ink"
								>
									<span className="grid size-5 place-items-center rounded-full bg-surface-2 text-xs tabular-nums">
										{i < stepIndex ? <Icon icon={Tick02Icon} size={16} /> : i + 1}
									</span>
									{s.label}
									{i < stepIndex ? <span className="sr-only"> (done)</span> : null}
								</button>
								{i < STEPS.length - 1 ? <span aria-hidden="true" className="h-px w-6 bg-line" /> : null}
							</li>
						))}
					</ol>
				</nav>
			</div>

			{meeting ? (
				<p className="rounded-md bg-surface px-4 py-3 text-md text-ink">
					<span className="font-medium">{meeting.title}</span>
					{` · ${meetingWhen(meeting.date, meeting.time)}${meeting.place ? ` · ${meeting.place}` : ""}`}
				</p>
			) : null}
			{notes.map((note) => (
				<p key={note} role="status" className="text-md text-ink">
					{note}
				</p>
			))}
			{problem ? (
				<p role="alert" className="text-sm font-medium text-magenta-600">
					{problem}
				</p>
			) : null}

			<h2
				ref={heading}
				tabIndex={-1}
				className="font-title text-title-md leading-[1.2] tracking-[-0.02em] text-ink outline-none"
			>
				{step === "who" ? "Who is this for?" : step === "write" ? "Write the message" : "Review and send"}
			</h2>

			{step === "who" ? (
				<WhoStep form={form} setForm={setForm} teams={data.teams} locked={locked} summary={summary} failed={failed} />
			) : null}

			{step === "write" ? (
				<div className="grid items-start gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
					<MessageEditor
						subject={form.subject}
						onSubject={(subject) => setForm((c) => ({ ...c, subject }))}
						text={form.text}
						onText={(text) => setForm((c) => ({ ...c, text }))}
						subjectError={!locked ? write?.subject : undefined}
						bodyError={!locked ? write?.body : undefined}
						hasMeeting={hasMeeting}
						disabled={locked}
						lossy={form.lossy}
					>
						{locked ? (
							<p className="text-sm text-text-2">
								This follow-up keeps the original subject and body. The original message was not changed. No email was
								sent.
							</p>
						) : (
							<div className="flex flex-col gap-2">
								<Field label="Start from a template">
									<Select
										value={form.templateKey}
										onValueChange={applyTemplate}
										options={[
											{ value: "none", label: "Choose a template", disabled: true },
											...templates.map((t) => ({ value: t.templateId, label: t.name })),
										]}
									/>
								</Field>
								{undo ? (
									<p role="status" className="text-sm text-text-2">
										Template applied.{" "}
										<button
											type="button"
											className="cursor-pointer font-medium text-ink underline underline-offset-[3px]"
											onClick={() => {
												setForm((c) => ({
													...c,
													subject: undo.subject,
													text: undo.text,
													templateKey: undo.templateKey,
													...undo.binding,
												}));
												setUndo(null);
											}}
										>
											Undo
										</button>
									</p>
								) : null}
							</div>
						)}
					</MessageEditor>
					<PreviewStage
						input={{
							bodyHtml: textToBody(form.text),
							name: previewName,
							hasMeeting,
							origin: data.origin,
							churchName: data.churchName,
						}}
						chrome={chrome}
					/>
				</div>
			) : null}

			{step === "review" ? (
				<ReviewStep
					form={form}
					templates={templates}
					teams={data.teams}
					summary={summary}
					meeting={meeting}
					churchName={data.churchName}
					origin={data.origin}
					sampleName={sample}
					canSend={eligible > 0 && audienceSize(form.audience) > 0}
					busy={pending !== null}
					onPlan={setPlan}
					onSaveDraft={saveOnly}
					onBack={() => void go("write")}
				/>
			) : null}

			<div
				// Review ends in the Send now button. A sticky bar would sit over it at first paint.
				className={`flex flex-wrap items-center justify-between gap-3 border-t border-line bg-[var(--ef-frame)] py-4 ${step === "review" ? "" : "sticky bottom-0"}`}
			>
				<p id="step-reason" className="text-sm text-text-2" role={reason ? "status" : undefined}>
					{reason ?? ""}
				</p>
				<div className="flex items-center gap-2">
					{stepIndex > 0 ? (
						<Button
							variant="secondary"
							onClick={() => void go(STEPS[stepIndex - 1]!.value)}
							disabled={pending !== null}
						>
							Back
						</Button>
					) : null}
					{!locked ? (
						<Button
							variant="ghost"
							onClick={saveOnly}
							loading={pending === "save"}
							disabled={pending !== null && pending !== "save"}
						>
							Save draft
						</Button>
					) : null}
					{stepIndex < STEPS.length - 1 ? (
						<Button
							variant="primary"
							aria-describedby="step-reason"
							disabled={reason !== null || pending !== null}
							loading={pending === "step"}
							onClick={() => void go(STEPS[stepIndex + 1]!.value)}
						>
							Next
						</Button>
					) : null}
				</div>
			</div>

			<ConfirmDialog
				open={plan !== null}
				onOpenChange={(open) => {
					if (open) return;
					setPlan(null);
					if (scheduledId) onDone(scheduledId, "Scheduled. It has not been sent.");
				}}
				title={
					plan?.kind === "at"
						? `Schedule for ${formatWhen(plan.at.toISOString())}?`
						: `Send to ${plural(eligible, "person", "people")} now?`
				}
				description={`"${form.subject}"`}
				consequences={consequences(plan?.kind === "at" ? `on ${formatWhen(plan.at.toISOString())}` : "right away")}
				confirmLabel={plan?.kind === "at" ? "Schedule email" : "Send now"}
				onConfirm={confirm}
			/>
			<ConfirmDialog
				open={leaving}
				onOpenChange={setLeaving}
				title="Leave without saving?"
				description="This message has changes that are not saved."
				consequences={["Your changes to this message are lost."]}
				confirmLabel="Leave"
				tone="danger"
				onConfirm={() => onLeave()}
			/>
		</div>
	);
}
