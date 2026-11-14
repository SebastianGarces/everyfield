"use client";

import type { EnrollmentDetail, VersionReview } from "@everyfield/contracts/organizations";
import { CheckmarkCircle02Icon, Layers01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	CalloutLabel,
	CalloutText,
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
import { useEffect, useState, type FormEvent } from "react";
import { formatDay, PIPELINE_PATH } from "../board/model";
import { Problem } from "../board/Problem";
import {
	addFeedback,
	applyVersion,
	confirmMilestone,
	recordMilestone,
	rereadEnrollment,
	reviewVersion,
} from "./actions";
import { formatMeeting, KIND, programHref, programProblem, PROGRAMS_PATH } from "./model";
import { Detail } from "./ProgramScreen";
import { ReviewParts } from "./VersionReview";

type Milestone = EnrollmentDetail["milestones"][number];
const lost = () => ({ status: "lost" as const });

/**
 * One enrollment (REQ-MUL-011, -012): the person's cohort, dates, program stage and next meeting on the version they
 * were enrolled on, and each milestone of that version. The director records and confirms an unlinked enrollee's
 * milestone in one step and writes dated feedback on hands-on assignments, which only the director, the Owner and
 * Admins read. When the program has a newer published version, the director reviews what changes for this person and
 * applies it (REQ-MUL-011); records on milestones the new version drops stay listed under earlier versions.
 */
export function EnrollmentScreen({ initial }: { initial: EnrollmentDetail }) {
	const [enrollment, setEnrollment] = useState(initial);
	const [recording, setRecording] = useState<Milestone | null>(null);
	const [reviewing, setReviewing] = useState(false);
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
			{enrollment.newerVersion && enrollment.status === "active" ? (
				<Card
					variant="callout"
					tone="blue"
					as="section"
					aria-label={`Version ${enrollment.newerVersion.number} is available`}
				>
					<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
						<div className="min-w-0 flex-1 basis-[320px]">
							<CalloutLabel tone="blue" icon={Layers01Icon}>
								Version {enrollment.newerVersion.number} is available
							</CalloutLabel>
							<CalloutText>
								{enrollment.person.name} stays on Version {enrollment.versionNumber} until{" "}
								{director ? "you apply" : `${enrollment.program.director.name}, the director, applies`} the new version.
								{director ? " You’ll review what changes for them first." : ""}
							</CalloutText>
						</div>
						{director ? (
							<Button variant="primary" className="flex-none" onClick={() => setReviewing(true)}>
								Apply Version {enrollment.newerVersion.number}
							</Button>
						) : null}
					</div>
				</Card>
			) : null}
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
								{firstName} chooses what you see from their own account. Their reading, reflections and documents are
								never shared.
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
						{enrollment.earlier.length ? (
							<section
								aria-label="From earlier versions"
								className="mt-5 flex flex-col gap-3 border-t border-line pt-4"
							>
								<h3 className="text-sm font-semibold text-ink-2">
									From earlier versions{" "}
									<span className="font-normal text-text-3">
										· Not in Version {enrollment.versionNumber}. Kept as recorded.
									</span>
								</h3>
								<ol className="flex flex-col divide-y divide-line">
									{enrollment.earlier.map((m) => (
										<MilestoneRow
											key={m.id}
											milestone={m}
											enrollment={enrollment}
											director={false}
											linked={resident.status === "linked"}
											hidden={resident.status === "linked" && resident.milestones === "not_shared"}
											recordedOn={m.versionNumber}
											onRecord={() => undefined}
											onChanged={reread}
										/>
									))}
								</ol>
							</section>
						) : null}
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
			{director && enrollment.newerVersion ? (
				<ApplyDialog
					open={reviewing}
					enrollment={enrollment}
					onClose={() => setReviewing(false)}
					onApplied={async () => {
						setReviewing(false);
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
	recordedOn,
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
	/** For a milestone a later version removed: the version its record is on. */
	recordedOn?: number;
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
								{recordedOn ? `Finished on Version ${recordedOn} · ` : ""}Completed {formatDay(c.completedOn)} ·
								Confirmed {formatDay(c.confirmedOn!)}
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
					) : recordedOn ? (
						<span className="text-text-3">Not finished on Version {recordedOn}</span>
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
			{m.feedback && (m.handsOn || m.feedback.length) ? (
				<Feedback milestone={m} enrollment={enrollment} director={director && m.handsOn} onChanged={onChanged} />
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

/**
 * The director's review before applying the program's current version to this enrollment (REQ-MUL-011): what is added,
 * removed and changed for this person, the finished milestones that carry over, and their stage on the new version.
 * Nothing is saved until they confirm. A review that went out of date is refused and replaced with a fresh one.
 */
function ApplyDialog({
	open,
	enrollment,
	onClose,
	onApplied,
}: {
	open: boolean;
	enrollment: EnrollmentDetail;
	onClose: () => void;
	onApplied: () => Promise<void>;
}) {
	return (
		<Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
			<DialogContent size="lg">
				{open ? <ApplyReview enrollment={enrollment} onClose={onClose} onApplied={onApplied} /> : null}
			</DialogContent>
		</Dialog>
	);
}

function ApplyReview({
	enrollment,
	onClose,
	onApplied,
}: {
	enrollment: EnrollmentDetail;
	onClose: () => void;
	onApplied: () => Promise<void>;
}) {
	const [review, setReview] = useState<VersionReview | null>(null);
	const [stageId, setStageId] = useState("");
	const [attempt, setAttempt] = useState(0);
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const name = enrollment.person.name;
	const number = review?.toNumber ?? enrollment.newerVersion!.number;

	useEffect(() => {
		let current = true;
		void reviewVersion(enrollment.id)
			.catch(lost)
			.then((answer) => {
				if (!current) return;
				if (answer.status !== "ok") {
					setReview(null);
					return setProblem(programProblem(answer));
				}
				setReview(answer.value);
				setStageId(answer.value.stageId);
			});
		return () => {
			current = false;
		};
	}, [enrollment.id, attempt]);

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!review) return;
		setSaving(true);
		setProblem(null);
		const answer = await applyVersion({
			enrollmentId: enrollment.id,
			versionId: review.versionId,
			stageId,
			basis: review.basis,
		}).catch(lost);
		setSaving(false);
		if (answer.status === "ok") return onApplied();
		setProblem(programProblem(answer));
		if (answer.status === "refused" && answer.refusal.code === "stale_review") setAttempt((n) => n + 1);
	}

	return (
		<form onSubmit={submit} noValidate className="contents">
			<DialogHeader
				title={`Apply Version ${number} to ${name}`}
				description={`Review what changes for ${name}. Nothing is saved until you confirm.`}
			/>
			<DialogBody className="flex flex-col gap-5">
				<Problem text={problem} />
				{review ? (
					<ReviewParts review={review} stageId={stageId} onStageChange={setStageId} />
				) : problem ? null : (
					<p className="text-sm text-text-3">Loading the review…</p>
				)}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" onClick={onClose} disabled={saving}>
					Cancel
				</Button>
				<Button type="submit" variant="primary" loading={saving} disabled={!review}>
					Apply Version {number}
				</Button>
			</DialogFooter>
		</form>
	);
}
