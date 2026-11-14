"use client";

import type { EnrollmentDetail } from "@everyfield/contracts/organizations";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardBody,
	CardHeader,
	CardTitle,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	PageHeader,
	Textarea,
} from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import { useState, type FormEvent } from "react";
import { formatDay, PIPELINE_PATH } from "../board/model";
import { Problem } from "../board/Problem";
import { addFeedback, confirmMilestone, recordMilestone, rereadEnrollment } from "./actions";
import { formatMeeting, KIND, programHref, programProblem, PROGRAMS_PATH } from "./model";
import { Detail } from "./ProgramScreen";

type Milestone = EnrollmentDetail["milestones"][number];
const lost = () => ({ status: "lost" as const });

/**
 * One enrollment (REQ-MUL-011, -012): the person's cohort, dates, program stage and next meeting on the version they
 * were enrolled on, and each milestone of that version. The director records and confirms an unlinked enrollee's
 * milestone in one step and writes dated feedback on hands-on assignments, which only the director, the Owner and
 * Admins read.
 */
export function EnrollmentScreen({ initial }: { initial: EnrollmentDetail }) {
	const [enrollment, setEnrollment] = useState(initial);
	const [recording, setRecording] = useState<Milestone | null>(null);
	const director = enrollment.viewer.director && enrollment.status === "active";
	const resident = enrollment.resident;
	const firstName = enrollment.person.name.split(" ")[0] ?? enrollment.person.name;

	async function reread() {
		const answer = await rereadEnrollment(enrollment.id).catch(() => null);
		if (answer?.status === "ok") setEnrollment(answer.value);
	}

	const finished = enrollment.milestones.filter((m) => m.completion?.confirmedOn).length;
	return (
		<div className="flex flex-col gap-5">
			<PageHeader
				breadcrumb={[
					{ label: "Pipeline", href: PIPELINE_PATH },
					{ label: "Programs", href: PROGRAMS_PATH },
					{ label: enrollment.program.name, href: programHref(enrollment.program.id) },
					{ label: enrollment.person.name },
				]}
				title={enrollment.person.name}
				subtitle={`${enrollment.program.name} · ${KIND[enrollment.program.kind]} · Version ${enrollment.versionNumber}`}
			/>
			<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-5 max-app-md:grid-cols-1">
				<Card>
					<CardHeader>
						<CardTitle>Enrollment</CardTitle>
					</CardHeader>
					<CardBody>
						<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
							<Detail term="Cohort">{enrollment.cohort}</Detail>
							<Detail term="Started">{formatDay(enrollment.startedOn)}</Detail>
							<Detail term="Expected end">{formatDay(enrollment.expectedEndOn)}</Detail>
							<Detail term="Program stage">{enrollment.stage.label}</Detail>
							<Detail term="Next meeting">
								{enrollment.nextMeeting
									? `${formatMeeting(enrollment.nextMeeting.at, formatDay)} (${enrollment.nextMeeting.timezone})`
									: "Not set"}
							</Detail>
							<Detail term="Plan">{`Version ${enrollment.versionNumber}`}</Detail>
							<Detail term="Status">{enrollment.status === "active" ? "Active" : enrollment.status}</Detail>
							<Detail term="Director">{enrollment.program.director.name}</Detail>
							<Detail term="Everyfield account">{resident.status === "linked" ? "Linked" : "Not linked"}</Detail>
							{resident.status === "linked" ? (
								<>
									<Detail term="Milestone progress">
										{resident.milestones === "shared" ? "Shared" : "Not shared"}
									</Detail>
									<Detail term="Foundations">
										{resident.foundations.status === "shared"
											? `${resident.foundations.completed} of ${resident.foundations.total} completed`
											: "Not shared"}
									</Detail>
								</>
							) : null}
						</dl>
						{resident.status === "linked" ? (
							<p className="mt-4 text-sm text-text-2">
								{firstName} chooses what you see from their own account. Their reading, reflections and documents
								are never shared.
							</p>
						) : null}
					</CardBody>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>
							Milestones{" "}
							<span className="font-body text-sm font-normal text-text-2">
								{finished} of {enrollment.milestones.length} finished
							</span>
						</CardTitle>
					</CardHeader>
					<CardBody>
						{resident.status === "linked" && resident.milestones === "not_shared" ? (
							<p className="mb-4 rounded-md bg-surface-2 p-3 text-sm text-ink-2">
								Milestone progress: Not shared. {firstName} keeps their own progress private. Milestones you recorded
								yourself still show here.
							</p>
						) : null}
						{enrollment.milestones.length ? (
							<ol className="flex flex-col divide-y divide-line">
								{enrollment.milestones.map((m) => (
									<MilestoneRow
										key={m.id}
										milestone={m}
										enrollment={enrollment}
										director={director}
										linked={resident.status === "linked"}
										hidden={resident.status === "linked" && resident.milestones === "not_shared"}
										onRecord={() => setRecording(m)}
										onChanged={reread}
									/>
								))}
							</ol>
						) : (
							<p className="text-sm text-text-3">This version has no milestones.</p>
						)}
					</CardBody>
				</Card>
			</div>
			{director && resident.status === "not_linked" ? (
				<RecordDialog
					milestone={recording}
					enrollment={enrollment}
					onClose={() => setRecording(null)}
					onRecorded={async () => {
						setRecording(null);
						await reread();
					}}
				/>
			) : null}
		</div>
	);
}

function MilestoneRow({
	milestone: m,
	enrollment,
	director,
	linked,
	hidden,
	onRecord,
	onChanged,
}: {
	milestone: Milestone;
	enrollment: EnrollmentDetail;
	director: boolean;
	/** The enrollee has a live linked account: they mark their own milestones, so there is no one-step record. */
	linked: boolean;
	/** The resident does not share milestone progress, so an empty row says nothing about whether it is done. */
	hidden: boolean;
	onRecord: () => void;
	onChanged: () => Promise<void>;
}) {
	const c = m.completion;
	const waiting = c !== null && c.confirmedOn === null;
	const [confirming, setConfirming] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	async function confirm() {
		setConfirming(true);
		setProblem(null);
		const answer = await confirmMilestone({ enrollmentId: enrollment.id, milestoneId: m.id }).catch(lost);
		setConfirming(false);
		if (answer.status !== "ok") return setProblem(programProblem(answer));
		await onChanged();
	}
	return (
		<li className="flex flex-col gap-2 py-3.5 first:pt-0 last:pb-0">
			<div className="flex flex-wrap items-start gap-x-3 gap-y-2">
				<span
					className={
						c && !waiting
							? "mt-0.5 flex-none text-green-700"
							: waiting
								? "mt-0.5 size-[18px] flex-none rounded-full border-2 border-amber-500 border-dashed"
								: "mt-0.5 size-[18px] flex-none rounded-full shadow-edge-inset"
					}
					aria-hidden
				>
					{c && !waiting ? <Icon icon={CheckmarkCircle02Icon} size={18} /> : null}
				</span>
				<div className="flex min-w-[220px] flex-1 basis-0 flex-col gap-0.5 text-sm">
					<span className="font-medium [overflow-wrap:anywhere] text-ink">{m.title}</span>
					{m.handsOn ? <span className="text-xs font-medium text-blue-600">Hands-on assignment</span> : null}
					{m.description ? <span className="[overflow-wrap:anywhere] text-text-2">{m.description}</span> : null}
					{c && c.confirmedOn === null ? (
						<>
							<span className="font-medium text-amber-600">Waiting for confirmation</span>
							<span className="text-text-2">
								{c.recorder ?? enrollment.person.name} marked it done {formatDay(c.completedOn)}
							</span>
						</>
					) : c ? (
						<>
							<span className="text-ink">
								Completed {formatDay(c.completedOn)} · Confirmed {formatDay(c.confirmedOn!)}
							</span>
							<span className="text-text-2">
								{c.source === "resident"
									? `Marked done by ${c.recorder ?? enrollment.person.name}, confirmed by ${c.confirmer ?? "former staff"}`
									: `${
											c.recorder === c.confirmer
												? `Recorded and confirmed by ${c.recorder ?? "former staff"}`
												: `Recorded by ${c.recorder ?? "former staff"}, confirmed by ${c.confirmer ?? "former staff"}`
										} · Recorded by the program leader`}
							</span>
						</>
					) : (
						<span className="text-text-3">{hidden ? "Progress not shared" : "Not finished"}</span>
					)}
					<Problem text={problem} />
				</div>
				{director && waiting ? (
					<Button
						size="sm"
						variant="primary"
						className="flex-none max-app-sm:ml-[30px]"
						loading={confirming}
						onClick={confirm}
					>
						Confirm
					</Button>
				) : null}
				{director && !c && !linked ? (
					<Button size="sm" variant="secondary" className="flex-none max-app-sm:ml-[30px]" onClick={onRecord}>
						Record as finished
					</Button>
				) : null}
			</div>
			{m.handsOn && m.feedback ? (
				<Feedback milestone={m} enrollment={enrollment} director={director} onChanged={onChanged} />
			) : null}
		</li>
	);
}

/** The director's dated feedback on one hands-on assignment. It describes the work and never judges a calling. */
function Feedback({
	milestone,
	enrollment,
	director,
	onChanged,
}: {
	milestone: Milestone;
	enrollment: EnrollmentDetail;
	director: boolean;
	onChanged: () => Promise<void>;
}) {
	const [writing, setWriting] = useState(false);
	const [body, setBody] = useState("");
	const [feedbackId, setFeedbackId] = useState(() => crypto.randomUUID());
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const items = milestone.feedback ?? [];

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!body.trim()) return setProblem("Write the feedback first.");
		setSaving(true);
		setProblem(null);
		const answer = await addFeedback({
			feedbackId,
			enrollmentId: enrollment.id,
			milestoneId: milestone.id,
			body: body.trim(),
		}).catch(lost);
		setSaving(false);
		if (answer.status !== "ok") return setProblem(programProblem(answer));
		setBody("");
		setWriting(false);
		setFeedbackId(crypto.randomUUID());
		await onChanged();
	}

	return (
		<section
			aria-label={`Feedback on ${milestone.title}`}
			className="ml-[30px] flex flex-col gap-2 rounded-md bg-surface-2 p-3"
		>
			<h4 className="text-xs font-semibold tracking-normal text-ink-2">
				Feedback{" "}
				<span className="font-normal text-text-3">
					·{" "}
					{enrollment.resident.status === "linked"
						? `Seen by ${enrollment.person.name}, the director, Owner and Admins`
						: "Seen by the director, Owner and Admins"}
				</span>
			</h4>
			{items.length ? (
				<ul className="flex flex-col gap-2.5">
					{items.map((f) => (
						<li key={f.id} className="flex flex-col gap-0.5 text-sm">
							<span className="whitespace-pre-wrap [overflow-wrap:anywhere] text-ink">{f.body}</span>
							<span className="text-xs text-text-3">
								{f.writer ?? "Former staff"} · {formatDay(f.writtenOn)}
							</span>
						</li>
					))}
				</ul>
			) : (
				<p className="text-sm text-text-3">No feedback yet.</p>
			)}
			{director ? (
				writing ? (
					<form onSubmit={submit} noValidate className="flex flex-col gap-2">
						<Textarea
							aria-label={`Feedback on ${milestone.title}`}
							value={body}
							onChange={(e) => setBody(e.target.value)}
							maxLength={5000}
							rows={3}
							placeholder="What went well, and what to work on next"
						/>
						<Problem text={problem} />
						<div className="flex justify-end gap-2">
							<Button variant="ghost" size="sm" onClick={() => setWriting(false)} disabled={saving}>
								Cancel
							</Button>
							<Button type="submit" variant="primary" size="sm" loading={saving}>
								Add feedback
							</Button>
						</div>
					</form>
				) : (
					<Button variant="secondary" size="sm" className="self-start" onClick={() => setWriting(true)}>
						Add feedback
					</Button>
				)
			) : null}
		</section>
	);
}

/** The director records the day the enrollee finished, and confirms it in the same step (REQ-MUL-012). */
function RecordDialog({
	milestone,
	enrollment,
	onClose,
	onRecorded,
}: {
	milestone: Milestone | null;
	enrollment: EnrollmentDetail;
	onClose: () => void;
	onRecorded: () => Promise<void>;
}) {
	return (
		<Dialog open={milestone !== null} onOpenChange={(open) => (open ? null : onClose())}>
			<DialogContent size="sm">
				{milestone ? <RecordForm milestone={milestone} enrollment={enrollment} onRecorded={onRecorded} /> : null}
			</DialogContent>
		</Dialog>
	);
}

function RecordForm({
	milestone,
	enrollment,
	onRecorded,
}: {
	milestone: Milestone;
	enrollment: EnrollmentDetail;
	onRecorded: () => Promise<void>;
}) {
	const [on, setOn] = useState<string>(enrollment.today);
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!on) return setProblem("Enter the day it was finished.");
		if (on > enrollment.today) return setProblem("The date can’t be after today.");
		setSaving(true);
		setProblem(null);
		const answer = await recordMilestone({
			enrollmentId: enrollment.id,
			milestoneId: milestone.id,
			completedOn: on,
		}).catch(lost);
		setSaving(false);
		if (answer.status !== "ok") return setProblem(programProblem(answer));
		await onRecorded();
	}
	return (
		<form onSubmit={submit} noValidate className="contents">
			<DialogHeader
				title="Record as finished"
				description={`${enrollment.person.name} has no linked account, so you record “${milestone.title}” and confirm it in one step, as program leader. Nothing else changes.`}
			/>
			<DialogBody className="flex flex-col gap-4">
				<Field label="Finished on">
					<Input type="date" value={on} max={enrollment.today} onChange={(e) => setOn(e.target.value)} />
				</Field>
				<p className="text-sm text-text-2">
					Confirmed today, {formatDay(enrollment.today)}, with you as recorder and confirmer.
				</p>
				<Problem text={problem} />
			</DialogBody>
			<DialogFooter>
				<Button type="submit" variant="primary" loading={saving}>
					Record and confirm
				</Button>
			</DialogFooter>
		</form>
	);
}
