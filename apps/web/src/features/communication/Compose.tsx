"use client";

import { ArrowLeft01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button, ConfirmDialog, Field, Select } from "@everyfield/ui/controls";
import { Icon, useFocusOnChange } from "@everyfield/ui/foundations";
import { useState, type ComponentProps } from "react";
import { createRead, useRead } from "../../components/read.tsx";
import { useLocalStore, useShallow, useStore } from "../../components/store.ts";
import { unsavedMark } from "../../components/save/leave.ts";
import { deleteDraft, readDraft, readMeetingContext, readMeetingTemplate, saveDraft, handOff } from "./actions.ts";
import { bodyToTextResult, textToBody } from "./body.ts";
import {
	audienceSize,
	draftPayload,
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
	scheduleText,
	outcomeText,
	scheduledNotSentText,
	templateBinding,
	type Draft,
	type Handoff,
	type MeetingContext,
	type Outcome,
	type PageData,
	type Step,
} from "./model.ts";
import { createComposeStore, type Opened, type Opening } from "./Compose.store.ts";
import { useKeys } from "./useKeys.ts";
import { ReviewStep } from "./ReviewStep.tsx";
import { useAudienceSummary, WhoStep } from "./WhoStep.tsx";

const STEPS: { value: Step; label: string }[] = [
	{ value: "who", label: "Who" },
	{ value: "write", label: "Write" },
	{ value: "review", label: "Review and send" },
];

function meetingWhen(date: string, time: string): string {
	const [y, m, d] = date.split("-").map(Number);
	const [h, min] = time.split(":").map(Number);
	if (!y || !m || !d || h === undefined || min === undefined) return `${date}, ${time}`;
	return new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(
		new Date(y, m - 1, d, h, min),
	);
}

const lost = <T,>(): Outcome<T> => ({ status: "lost" });

async function open(id: string, handoff: Handoff | null): Promise<Opening> {
	if (id !== "new") {
		const draft = await readDraft(id);
		if (draft.status === "lost") return { kind: "unreachable" };
		return draft.status === "ok" ? { kind: "draft", draft: draft.value } : { kind: "missing" };
	}
	if (!handoff) return { kind: "new", meeting: null, template: null, guests: false, notes: [] };
	const context = await readMeetingContext(handoff.meeting);
	if (context.status === "lost") return { kind: "unreachable" };
	if (context.status !== "ok")
		return {
			kind: "new",
			meeting: null,
			template: null,
			guests: false,
			notes: ["That meeting is not available. The message has no meeting."],
		};
	const found = handoff.template ? await readMeetingTemplate(context.value.type) : null;
	if (found?.status === "lost") return { kind: "unreachable" };
	return {
		kind: "new",
		meeting: context.value,
		template: found?.status === "ok" ? found.value : null,
		guests: handoff.recipients === "guests",
		notes:
			found && found.status !== "ok"
				? ["No invitation template for this meeting type. Write the message, or start from another template."]
				: [],
	};
}

const openings = createRead(open, {
	failed: (): Opening => ({ kind: "unreachable" }),
	keep: (opening) => opening.kind !== "unreachable",
});
const meetingContexts = createRead((meetingId: string) => readMeetingContext(meetingId), {
	failed: lost<MeetingContext>,
});

const SAMPLE = pickSampleName("compose");

type Shown = { id: string; handoff: Handoff | null; held: string | null };

const stillShown = (shown: Shown, id: string, handoff: Handoff | null) =>
	id === shown.held ||
	(id === shown.id && JSON.stringify(handoff) === JSON.stringify(shown.handoff)) ||
	(id === "new" && handoff === null && shown.id === "new");

type ComposeProps = {
	data: PageData;
	id: string;
	step: Step;
	handoff: Handoff | null;
	onStep: (step: Step) => void;
	onSaved: (id: string, step: Step) => void;
	onLeave: () => void;
	onDeleted: () => void;
	onDone: (messageId: string, text: string) => void;
};

export function Compose(props: ComposeProps) {
	const [shown, setShown] = useState<Shown>({ id: props.id, handoff: props.handoff, held: null });
	const next = stillShown(shown, props.id, props.handoff)
		? shown
		: { id: props.id, handoff: props.handoff, held: null };
	if (next !== shown) setShown(next);
	const openId = next.id;
	const openHandoff = next.handoff;
	const opening = useRead(openings, openId, openHandoff);
	const opened = opening.value;
	if (opened === undefined) {
		return (
			<p role="status" className="text-md text-text-2">
				Opening the message.
			</p>
		);
	}
	if (opened.kind === "unreachable") {
		return (
			<div className="flex flex-col items-start gap-3">
				<p role="alert" className="text-md font-medium text-magenta-600">
					{outcomeText({ status: "lost" })}
				</p>
				<div className="flex flex-wrap gap-2">
					<Button variant="secondary" onClick={opening.retry}>
						Try again
					</Button>
					<Button variant="ghost" onClick={props.onLeave}>
						Back to messages
					</Button>
				</div>
			</div>
		);
	}
	if (opened.kind === "missing") {
		return (
			<div className="flex flex-col items-start gap-3">
				<p role="alert" className="text-md font-medium text-magenta-600">
					That message is not here. It may have been deleted.
				</p>
				<Button variant="secondary" onClick={props.onLeave}>
					Back to messages
				</Button>
			</div>
		);
	}
	return (
		<ComposeForm
			key={openings.key(openId, openHandoff)}
			{...props}
			opening={opened}
			onHeld={(id) => setShown((current) => ({ ...current, held: id }))}
		/>
	);
}

function ComposeForm({
	data,
	id,
	step,
	opening,
	onHeld,
	onStep,
	onSaved,
	onLeave,
	onDeleted,
	onDone,
}: ComposeProps & { opening: Opened; onHeld: (id: string) => void }) {
	const keys = useKeys();
	const store = useLocalStore(() => createComposeStore({ opening, templates: data.templates }));
	const { form, saved, extra, notes, undo, pending, problem, plan, scheduledId, counted, previewed, actions } =
		useStore(
			store,
			useShallow((state) => ({
				form: state.form,
				saved: state.saved,
				extra: state.extra,
				notes: state.notes,
				undo: state.undo,
				pending: state.pending,
				problem: state.problem,
				plan: state.plan,
				scheduledId: state.scheduledId,
				counted: state.counted,
				previewed: state.previewed,
				actions: state.actions,
			})),
		);
	const heading = useFocusOnChange<HTMLHeadingElement>(step);
	const openedMeeting = opening.kind === "new" ? opening.meeting : null;
	const meetingRead = useRead(!openedMeeting && form.meetingId ? meetingContexts : null, form.meetingId ?? "");
	const meeting = openedMeeting ?? (meetingRead.value?.status === "ok" ? meetingRead.value.value : null);
	const { summary, failed, ready } = useAudienceSummary(form.audience, counted);
	const templates = [
		...data.templates,
		...extra.filter((t) => !data.templates.some((d) => d.templateId === t.templateId)),
	];
	const locked = isLocked(form);

	const payload = JSON.stringify(draftPayload(form));
	const dirty = !locked && payload !== saved;

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
		if (!actions.begin(name)) return;
		try {
			await body();
		} finally {
			actions.end();
		}
	};

	const persist = async (target: Step): Promise<Form | null> => {
		if (locked) return form;
		const result = await saveDraft(keys.take("save"), form.revision, draftPayload(form)).catch(lost<Draft>);
		keys.settle("save", result);
		if (result.status !== "ok") {
			actions.fail(outcomeText(result));
			return null;
		}
		const draft = result.value;
		const next: Form = {
			...form,
			communicationId: draft.communicationId,
			revision: draft.revision,
			state: draft.state,
		};
		actions.hold(next);
		onHeld(draft.communicationId);
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
			if (locked || (!form.communicationId && target !== "review")) onStep(target);
			else await persist(target);
		});

	const saveOnly = () =>
		guard("save", async () => {
			const next = await persist(step);
			if (next) actions.note(["Draft saved."]);
		});

	const canDelete = form.state === "draft" && form.communicationId !== null && form.revision !== null;

	const removeDraft = async () => {
		if (!form.communicationId || !form.revision) throw new Error("Save the message before you delete it.");
		const result = await deleteDraft(keys.take("delete"), form.revision, form.communicationId).catch(lost<Draft>);
		keys.settle("delete", result);
		if (result.status !== "ok") {
			throw new Error(`${outcomeText(result) ?? "The draft was not deleted."} The draft is still in your list.`);
		}
		onDeleted();
	};

	const applyTemplate = (key: string) => {
		const template = templates.find((t) => t.templateId === key);
		if (!template) return;
		const changed = form.subject.trim() !== "" || form.text.trim() !== "";
		const previous = templates.find((t) => t.templateId === form.templateKey);
		const same =
			previous &&
			previous.subject === form.subject &&
			textToBody(form.text) === textToBody(bodyToTextResult(previous.bodyHtml).text);
		actions.offerUndo(
			changed && !same
				? {
						subject: form.subject,
						text: form.text,
						templateKey: form.templateKey,
						binding: { templateId: form.templateId, templateSource: form.templateSource },
					}
				: null,
		);
		actions.edit((current) => ({
			...current,
			subject: template.subject,
			text: bodyToTextResult(template.bodyHtml).text,
			templateKey: template.templateId,
			...templateBinding(template),
		}));
	};

	const confirm = async () => {
		if (!plan) return;
		if (!form.communicationId || !form.revision) throw new Error("Save the message before you send it.");
		const target =
			form.state === "reviewed"
				? ({ kind: "reviewed", communicationId: form.communicationId } as const)
				: ({ kind: "draft", input: draftPayload(form) } as const);
		const steps = { save: keys.take("save"), schedule: keys.take("schedule"), send: keys.take("send") };
		const result = await handOff(steps, form.revision, target, plan.kind === "now" ? null : plan.at.toISOString());
		keys.settle("save", result);
		keys.settle("schedule", result);
		if (result.status !== "ok")
			throw new Error(
				outcomeText(result) ?? (plan.kind === "now" ? "The email was not sent." : "The email was not scheduled."),
			);
		keys.settle("send", { status: "ok", value: null });
		const { report, communicationId } = result.value;
		if (report === null) {
			actions.edit(() => ({ ...form, communicationId, revision: result.value.revision, state: "scheduled" }));
			actions.scheduled(communicationId);
			throw new Error(scheduledNotSentText);
		}
		onDone(
			communicationId,
			plan.kind === "now" ? deliveryText(report) : scheduleText(report, formatWhen(result.value.scheduledAt)),
		);
	};

	const names = summary?.missingEmailExclusions ?? [];
	const consequences = (when: string) => [
		`${plural(eligible, "person gets", "people get")} this email ${when}.`,
		...(names.length ? [`${listed(names)} ${names.length === 1 ? "has" : "have"} no email and will be skipped.`] : []),
		"You cannot unsend it once it leaves.",
	];

	const stepIndex = STEPS.findIndex((s) => s.value === step);
	const previewName = summary?.recipients[0]?.displayName ?? SAMPLE;
	const chrome = { from: data.churchName, to: previewName, subject: form.subject };

	return (
		<div {...unsavedMark(dirty)} data-compose-draft={id} className="flex flex-col gap-6">
			<div className="flex flex-wrap items-center justify-between gap-4">
				{dirty ? (
					<ConfirmDialog
						trigger={<BackToMessages />}
						title="Leave without saving?"
						description="This message has changes that are not saved."
						consequences={["Your changes to this message are lost."]}
						confirmLabel="Leave"
						tone="danger"
						onConfirm={() => onLeave()}
					/>
				) : (
					<BackToMessages onClick={onLeave} />
				)}
				<nav aria-label="Steps">
					<ol className="flex items-center gap-2">
						{STEPS.map((s, i) => (
							<li key={s.value} className="flex items-center gap-2">
								<button
									type="button"
									aria-current={s.value === step ? "step" : undefined}
									onClick={() => void go(s.value)}
									className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-md font-medium text-text-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ef-focus)] aria-[current=step]:bg-surface-2 aria-[current=step]:text-ink"
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
				<WhoStep store={store} teams={data.teams} locked={locked} summary={summary} failed={failed} />
			) : null}

			{step === "write" ? (
				<div className="grid items-start gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
					<MessageEditor
						subject={form.subject}
						onSubject={(subject) => actions.edit((c) => ({ ...c, subject }))}
						text={form.text}
						onText={(text) => actions.edit((c) => ({ ...c, text }))}
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
											className="font-medium text-ink underline underline-offset-[3px]"
											onClick={() => {
												actions.edit((c) => ({
													...c,
													subject: undo.subject,
													text: undo.text,
													templateKey: undo.templateKey,
													...undo.binding,
												}));
												actions.offerUndo(null);
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
						live={textToBody(form.text)}
						input={{
							bodyHtml: textToBody(previewed),
							name: previewName,
							hasMeeting,
							origin: data.origin,
							churchName: data.churchName,
							mailingAddress: data.mailingAddress,
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
					mailingAddress={data.mailingAddress}
					origin={data.origin}
					sampleName={SAMPLE}
					canSend={eligible > 0 && audienceSize(form.audience) > 0}
					busy={pending !== null}
					onPlan={actions.plan}
					onSaveDraft={saveOnly}
					onBack={() => void go("write")}
				/>
			) : null}

			<div
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
					{canDelete ? (
						<ConfirmDialog
							trigger={
								<Button variant="ghost" disabled={pending !== null}>
									Delete draft
								</Button>
							}
							title="Delete this draft?"
							description={`"${form.subject.trim() || "No subject"}"`}
							consequences={["The draft is removed for good.", "You cannot undo this. No email was sent."]}
							confirmLabel="Delete draft"
							tone="danger"
							onConfirm={removeDraft}
						/>
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
					actions.plan(null);
					if (scheduledId) onDone(scheduledId, scheduledNotSentText);
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
		</div>
	);
}

function BackToMessages(props: ComponentProps<"button">) {
	return (
		<button
			type="button"
			{...props}
			className="inline-flex items-center gap-1.5 rounded-sm text-md font-medium text-ink-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ef-focus)]"
		>
			<Icon icon={ArrowLeft01Icon} size={16} />
			Back to messages
		</button>
	);
}
