"use client";

import {
	Add01Icon,
	BookOpen01Icon,
	Certificate01Icon,
	FileEditIcon,
	MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	EmptyState,
	IconButton,
	Menu,
	MenuContent,
	MenuItem,
	MenuTrigger,
	Spinner,
	StatePanel,
	useToast,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { useEffect, useRef, useState } from "react";
import { NoticeInDialog, SaveNotice, useSaveIntent } from "../../../components/save/parts.tsx";
import { dayText } from "../model.ts";
import {
	attestCompletion,
	correctProgram,
	createProgram,
	loadTraining,
	previewRoster,
	recompleteTraining,
	revokeCompletion,
	saveRoster,
} from "./actions.ts";
import { AssignDialog, CompletionDialog, CorrectDialog, CreateDialog, ServiceDialog } from "./dialogs.tsx";
import { PersonLookup } from "./PersonLookup.tsx";
import {
	applyCorrect,
	applyCreate,
	applyCredit,
	applyRoster,
	assignForm,
	canWriteProgram,
	correctForm,
	createForm,
	personForm,
	problemText,
	progressText,
	serviceForm,
	toShown,
	type Flow,
	type ShownProgram,
} from "./model.ts";

// The ministry Training tab. One save at a time. A write updates this list from its own answer.

export function TrainingTab({
	teamId,
	teamName,
	people,
	canChange,
	admin,
}: {
	teamId: string;
	teamName: string;
	people: { id: string; name: string }[];
	canChange: boolean;
	admin: boolean;
}) {
	const toast = useToast();
	const lane = useSaveIntent<Flow>({ explain: problemText });
	const [programs, setPrograms] = useState<ShownProgram[] | null>(null);
	const [failed, setFailed] = useState<"refused" | "lost" | null>(null);
	const [reason, setReason] = useState("unavailable");
	const [pending, setPending] = useState(true);
	const [request, setRequest] = useState(0);
	const [tick, setTick] = useState(0);
	const shown = useRef(false);
	const busy = lane.wait !== null;

	useEffect(() => {
		let live = true;
		loadTraining().then(
			(result) => {
				if (!live) return;
				setPending(false);
				if (result.status === "ok") {
					shown.current = true;
					setPrograms(toShown(result.value, teamId));
					setFailed(null);
					return;
				}
				if (!shown.current) {
					setFailed(result.status === "refused" ? "refused" : "lost");
					if (result.status === "refused") setReason(result.code);
				}
			},
			() => {
				if (!live) return;
				setPending(false);
				if (!shown.current) setFailed("lost");
			},
		);
		return () => {
			live = false;
		};
	}, [request, teamId]);

	function reload() {
		if (busy || pending) return;
		setPending(true);
		setRequest((n) => n + 1);
	}

	function refused(code: string) {
		if (code === "conflict") reload();
	}

	function tell(tone: "success" | "info", message: string) {
		toast({ tone, message });
	}

	function submit(form: Flow) {
		if (busy) return;
		switch (form.kind) {
			case "create":
				void lane.save({
					what: "The program",
					done: "added",
					form,
					send: (key) =>
						createProgram(key, {
							name: form.name.trim(),
							required: form.required,
							teamId: form.churchwide && admin ? null : teamId,
						}),
					ok: (value) => {
						setPrograms((rows) => applyCreate(rows ?? [], value.program, teamId));
						tell("success", `Added ${value.program.name}.`);
					},
					refused,
				});
				return;
			case "correct":
				void lane.save({
					what: form.name.trim() || "The program",
					done: "corrected",
					form,
					send: (key) =>
						correctProgram(key, form.revision, {
							programId: form.programId,
							name: form.name.trim(),
							required: form.required,
							reason: form.reason.trim(),
						}),
					ok: (value) => {
						setPrograms((rows) => applyCorrect(rows ?? [], value, teamId));
						tell(
							value.outcome === "noop" ? "info" : "success",
							value.outcome === "noop"
								? "Those details already match. Nothing changed."
								: `Corrected. This is now version ${value.program.version}. Earlier completions stay on the version they earned.`,
						);
					},
					refused,
				});
				return;
			case "assign":
				void lane.save({
					what: `Who must finish ${form.programName}`,
					done: "saved",
					form,
					send: async (key) => {
						const preview = await previewRoster(form.programId, form.personIds);
						if (preview.status !== "ok") return preview;
						return saveRoster(key, preview.value.revision, {
							programId: form.programId,
							personIds: preview.value.personIds,
							rosterDigest: preview.value.rosterDigest,
						});
					},
					ok: (value) => {
						setPrograms((rows) => applyRoster(rows ?? [], value));
						tell(
							value.outcome === "noop" ? "info" : "success",
							value.outcome === "noop"
								? "The required list already matches. Nothing changed."
								: `Saved who must finish ${form.programName}.`,
						);
					},
					refused,
				});
				return;
			case "complete":
			case "redo":
			case "revoke":
				if (!form.personId) return;
				void lane.save({
					what: form.kind === "revoke" ? `The completion of ${form.programName}` : form.programName,
					done: form.kind === "revoke" ? "revoked" : "recorded",
					form,
					send: (key) =>
						form.kind === "revoke"
							? revokeCompletion(key, form.revision, { personId: form.personId!, programId: form.programId })
							: form.kind === "redo"
								? recompleteTraining(key, form.revision, {
										personId: form.personId!,
										programId: form.programId,
										earnedOn: form.earnedOn,
									})
								: attestCompletion(key, form.revision, {
										kind: "program",
										personId: form.personId!,
										programId: form.programId,
										earnedOn: form.earnedOn,
									}),
					ok: (value) => {
						setPrograms((rows) => applyCredit(rows ?? [], value));
						setTick((n) => n + 1);
						tell(value.outcome === "noop" ? "info" : "success", creditMessage(form, value.outcome));
					},
					refused,
				});
				return;
			case "service":
				if (!form.personId) return;
				void lane.save({
					what: "Attendance and serving",
					done: "recorded",
					form,
					send: (key) =>
						attestCompletion(key, "0", {
							kind: "service",
							personId: form.personId!,
							attendanceDays: Number(form.attendanceDays),
							volunteerDays: Number(form.volunteerDays),
						}),
					ok: (value) => {
						setTick((n) => n + 1);
						tell(
							"success",
							value.candidate
								? "Recorded. Both totals are at least 60 days. This can invite a leadership conversation. It does not change their stage."
								: "Recorded. This does not establish 60 days of attendance and serving.",
						);
					},
					refused,
				});
				return;
		}
	}

	const editing = lane.editing;
	const rosterKnown =
		editing?.kind === "assign"
			? (programs?.find((program) => program.id === editing.programId)?.rosterKnown ?? false)
			: true;
	const staleCounts = programs?.some((program) => !program.countsKnown) ?? false;

	return (
		<div className="flex flex-col gap-5">
			<SaveNotice {...lane.noticeProps} dialogOpen={editing !== null} />
			<Card as="section" aria-labelledby="training-title">
				<CardHeader className="flex-wrap">
					<CardHeading>
						<CardTitle id="training-title">Training</CardTitle>
						<CardDescription>
							Record a completion, revoke it, or correct the program. A scheduled session does not finish training.
						</CardDescription>
					</CardHeading>
					{canChange ? (
						<div className="flex flex-wrap justify-end gap-2 max-app-sm:w-full">
							<Button
								variant="outline"
								icon={Certificate01Icon}
								disabled={busy}
								onClick={() => lane.open(serviceForm())}
							>
								Record attendance and serving
							</Button>
							<Button variant="primary" icon={Add01Icon} disabled={busy} onClick={() => lane.open(createForm())}>
								Add a program
							</Button>
						</div>
					) : null}
				</CardHeader>
				{lane.saving ? (
					<p role="status" className="mb-4 text-sm text-text-2">
						Saving…
					</p>
				) : null}
				{pending && programs ? (
					<p role="status" className="mb-4 flex items-center gap-2 text-sm text-text-3">
						<Spinner size={16} /> Loading finished counts…
					</p>
				) : null}
				{programs === null && pending ? (
					<p role="status" className="flex items-center gap-2 py-4 text-sm text-text-3">
						<Spinner size={16} /> Loading training…
					</p>
				) : programs === null ? (
					<StatePanel
						tone="error"
						title="Training did not load"
						headingLevel="h3"
						actions={
							<Button variant="secondary" onClick={reload} disabled={pending}>
								Try again
							</Button>
						}
					>
						{failed === "refused" ? problemText(reason) : `Nothing on ${teamName} was changed. Try again in a moment.`}
					</StatePanel>
				) : programs.length === 0 ? (
					<EmptyState
						icon={BookOpen01Icon}
						title="No training programs yet"
						headingLevel="h3"
						action={
							canChange ? (
								<Button variant="primary" icon={Add01Icon} disabled={busy} onClick={() => lane.open(createForm())}>
									Add a program
								</Button>
							) : undefined
						}
					>
						A program is what people finish. Add one, then record the day you confirmed they finished.
					</EmptyState>
				) : (
					<>
						{staleCounts ? (
							<div className="mb-4">
								<Button variant="outline" onClick={reload} disabled={busy || pending}>
									Reload finished counts
								</Button>
							</div>
						) : null}
						<ul className="flex flex-col">
							{programs.map((program) => (
								<li key={program.id} className="border-t border-line py-6 first:border-t-0 first:pt-0">
									<ProgramRow
										program={program}
										teamId={teamId}
										canChange={canChange}
										admin={admin}
										busy={busy}
										onOpen={lane.open}
									/>
								</li>
							))}
						</ul>
					</>
				)}
			</Card>
			<PersonLookup
				programs={programs ?? []}
				canRecordService={canChange}
				canWrite={(program) => canWriteProgram(program, teamId, canChange, admin)}
				busy={busy}
				tick={tick}
				onOpen={lane.open}
			/>
			<NoticeInDialog {...lane.noticeProps}>
				<TrainingDialogs
					editing={editing}
					admin={admin}
					directory={people}
					rosterKnown={rosterKnown}
					problem={lane.problem}
					wait={lane.wait}
					onClose={lane.close}
					onSubmit={submit}
				/>
			</NoticeInDialog>
		</div>
	);
}

function creditMessage(
	form: Extract<Flow, { kind: "complete" | "redo" | "revoke" }>,
	outcome: "changed" | "noop",
): string {
	if (form.kind === "revoke") {
		return outcome === "noop"
			? "There is no current completion to revoke."
			: "Revoked. The earlier completion stays in the history.";
	}
	if (outcome === "noop") return `Already recorded for this version of ${form.programName}.`;
	if (form.kind === "redo") return "Recorded again. The earlier completion stays in the history.";
	return `Recorded. ${form.personName} finished ${form.programName} on ${dayText(form.earnedOn)}.`;
}

function ProgramRow({
	program,
	teamId,
	canChange,
	admin,
	busy,
	onOpen,
}: {
	program: ShownProgram;
	teamId: string;
	canChange: boolean;
	admin: boolean;
	busy: boolean;
	onOpen: (form: Flow) => void;
}) {
	const writable = canWriteProgram(program, teamId, canChange, admin);
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-2">
				<h3 className="font-title text-title-sm tracking-[-0.02em] text-ink text-pretty">{program.name}</h3>
				<div className="flex flex-wrap gap-2">
					<StatusBadge status={program.required ? "attention" : "unknown"} plain>
						{program.required ? "Required" : "Optional"}
					</StatusBadge>
					{program.teamId === null ? <StatusBadge status="measured">Every ministry</StatusBadge> : null}
					{program.archived ? <StatusBadge status="unknown">Archived</StatusBadge> : null}
					<StatusBadge status="unknown" plain>
						Version {program.version}
					</StatusBadge>
				</div>
				<p className="text-sm text-text-2">{progressText(program)}</p>
				{program.archived ? <p className="text-sm text-text-3">Archived. Its history stays.</p> : null}
				{!writable && program.teamId === null && !program.archived ? (
					<p className="text-sm text-text-3">An Owner or Admin records this program.</p>
				) : null}
			</div>
			{writable ? (
				<div className="flex flex-wrap items-center gap-2">
					<Button variant="primary" disabled={busy} onClick={() => onOpen(personForm("complete", program))}>
						Record completion
					</Button>
					<Button variant="danger" disabled={busy} onClick={() => onOpen(personForm("revoke", program))}>
						Revoke completion
					</Button>
					<Button variant="outline" icon={FileEditIcon} disabled={busy} onClick={() => onOpen(correctForm(program))}>
						Correct program
					</Button>
					<Menu>
						<MenuTrigger asChild>
							<IconButton icon={MoreHorizontalIcon} label={`More actions for ${program.name}`} disabled={busy} />
						</MenuTrigger>
						<MenuContent>
							<MenuItem onSelect={() => onOpen(personForm("redo", program))}>Record again</MenuItem>
							{program.required ? (
								<MenuItem onSelect={() => onOpen(assignForm(program))}>Choose who must finish</MenuItem>
							) : null}
						</MenuContent>
					</Menu>
				</div>
			) : null}
		</div>
	);
}

function TrainingDialogs({
	editing,
	admin,
	directory,
	rosterKnown,
	problem,
	wait,
	onClose,
	onSubmit,
}: {
	editing: Flow | null;
	admin: boolean;
	directory: { id: string; name: string }[];
	rosterKnown: boolean;
	problem?: string;
	wait: ReturnType<typeof useSaveIntent<Flow>>["wait"];
	onClose: () => void;
	onSubmit: (form: Flow) => void;
}) {
	if (!editing) return null;
	if (editing.kind === "create") {
		return (
			<CreateDialog form={editing} admin={admin} problem={problem} wait={wait} onClose={onClose} onSubmit={onSubmit} />
		);
	}
	if (editing.kind === "correct") {
		return <CorrectDialog form={editing} problem={problem} wait={wait} onClose={onClose} onSubmit={onSubmit} />;
	}
	if (editing.kind === "assign") {
		return (
			<AssignDialog
				form={editing}
				directory={directory}
				rosterKnown={rosterKnown}
				problem={problem}
				wait={wait}
				onClose={onClose}
				onSubmit={onSubmit}
			/>
		);
	}
	if (editing.kind === "service") {
		return <ServiceDialog form={editing} problem={problem} wait={wait} onClose={onClose} onSubmit={onSubmit} />;
	}
	return <CompletionDialog form={editing} problem={problem} wait={wait} onClose={onClose} onSubmit={onSubmit} />;
}
