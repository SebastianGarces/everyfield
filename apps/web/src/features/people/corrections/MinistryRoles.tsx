"use client";

import type * as c from "@everyfield/contracts/teams";
import { Calendar03Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Field,
	Input,
	IntentLink,
	Textarea,
	useToast,
} from "@everyfield/ui/controls";
import { useOptimistic, useState, useTransition } from "react";
import type { z } from "zod";
import { RecordDialog, SaveNotice, useSaveIntent } from "../../../components/save/parts.tsx";
import { correctTenure } from "../../teams/actions.ts";
import { dayText, problemText } from "../../teams/model.ts";

type Role = z.infer<typeof c.assignmentRow>;
type Form = { role: Role; startedOn: string; endedOn: string; reason: string; problem?: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** What is wrong with the form before anything is sent, by field. Empty when it can save. */
export function roleDateProblems(f: Pick<Form, "role" | "startedOn" | "endedOn" | "reason">) {
	const ended = f.role.endedOn !== null;
	return {
		...(DATE.test(f.startedOn) ? {} : { startedOn: "Choose a start date." }),
		...(ended && !DATE.test(f.endedOn) ? { endedOn: "Choose an end date." } : {}),
		...(ended && DATE.test(f.startedOn) && DATE.test(f.endedOn) && f.endedOn < f.startedOn
			? { endedOn: "The end date cannot be before the start date." }
			: {}),
		...(f.reason.trim() ? {} : { reason: "Say why the dates change. The ministry's history keeps it." }),
	};
}

/**
 * The person's ministry roles, now and before (REQ-TEAM-006). An Owner or Admin can correct a role's recorded start or
 * end date with a reason; the row shows the new dates at once, keeps them when the save is confirmed and goes back with
 * the reason when it is refused. The ministry's history names the old and new dates, the reason and who made it.
 */
export function MinistryRoles({ initial, canCorrect }: { initial: Role[]; canCorrect: boolean }) {
	const toast = useToast();
	const [roles, setRoles] = useState(initial);
	const [shown, project] = useOptimistic(roles, (list: Role[], next: Role) =>
		list.map((r) => (r.tenureId === next.tenureId ? next : r)),
	);
	const [, startTransition] = useTransition();
	const lane = useSaveIntent<Form>({ explain: correctionProblem });
	const editing = lane.editing;

	function open(role: Role) {
		lane.open({ role, startedOn: role.startedOn, endedOn: role.endedOn ?? "", reason: "" });
	}
	function submit(f: Form): boolean {
		if (Object.keys(roleDateProblems(f)).length) return false;
		const unchanged = f.startedOn === f.role.startedOn && (f.endedOn || null) === f.role.endedOn;
		if (unchanged) {
			lane.close();
			return true;
		}
		const next: Role = {
			...f.role,
			startedOn: f.startedOn as Role["startedOn"],
			endedOn: f.role.endedOn === null ? null : (f.endedOn as Role["startedOn"]),
		};
		startTransition(async () => {
			project(next);
			await lane.save({
				what: `The dates of ${f.role.roleName}`,
				form: f,
				send: (key) =>
					correctTenure(key, f.role.revision, {
						tenureId: f.role.tenureId,
						startedOn: next.startedOn,
						endedOn: next.endedOn,
						reason: f.reason.trim(),
					}),
				ok: (value: z.infer<typeof c.tenureMutationResult>) => {
					setRoles((list) => list.map((r) => (r.tenureId === value.assignment.tenureId ? value.assignment : r)));
					toast({ tone: "success", message: `${f.role.roleName} dates corrected. The ministry's history keeps why.` });
				},
			});
		});
		return true;
	}

	return (
		<Card as="section" aria-labelledby="ministry-roles">
			<CardHeader className="mb-2">
				<CardHeading>
					<CardTitle id="ministry-roles" size="sm">
						Ministry roles
					</CardTitle>
					{shown.length ? <CardDescription>Now and before</CardDescription> : null}
				</CardHeading>
			</CardHeader>
			<SaveNotice {...lane.noticeProps} dialogOpen={editing !== null} />
			{shown.length === 0 ? (
				<p className="text-sm text-text-3">No ministry roles yet. Fill a role from a ministry&apos;s page.</p>
			) : (
				<ul className="flex flex-col divide-y divide-line">
					{shown.map((r) => (
						<li key={r.tenureId} className="flex items-start justify-between gap-3 py-2.5">
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="font-medium text-ink">{r.roleName}</span>
								<IntentLink
									href={`/ministries/${r.teamId}`}
									className="w-fit cursor-pointer text-sm text-text-2 underline-offset-2 hover:underline"
								>
									{r.teamName}
								</IntentLink>
								<span className="text-sm text-text-3">
									{dayText(r.startedOn)} – {r.endedOn ? dayText(r.endedOn) : "now"}
								</span>
							</span>
							{canCorrect ? (
								<Button
									variant="ghost"
									size="sm"
									icon={Calendar03Icon}
									disabled={lane.wait !== null}
									onClick={() => open(r)}
								>
									Correct dates
								</Button>
							) : null}
						</li>
					))}
				</ul>
			)}
			{editing ? <DatesDialog form={editing} lane={lane} onSubmit={submit} /> : null}
		</Card>
	);
}

function DatesDialog({
	form,
	lane,
	onSubmit,
}: {
	form: Form;
	lane: ReturnType<typeof useSaveIntent<Form>>;
	onSubmit: (f: Form) => boolean;
}) {
	const [f, setF] = useState(form);
	// A form a refusal opened again shows its problems at once; a new one after its first submit.
	const [touched, setTouched] = useState(form.problem !== undefined);
	const ended = f.role.endedOn !== null;
	const problems: Partial<Record<"startedOn" | "endedOn" | "reason", string>> = touched ? roleDateProblems(f) : {};
	const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
	return (
		<RecordDialog
			icon={UserGroupIcon}
			tone="violet"
			title="Correct role dates"
			description={`${f.role.roleName} in ${f.role.teamName}. Use this to fix a date recorded wrong.`}
			action="Save dates"
			problem={lane.problem}
			wait={lane.wait}
			onClose={lane.close}
			onSubmit={() => {
				setTouched(true);
				return onSubmit(f);
			}}
		>
			<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
				<Field label="Start date" error={problems.startedOn}>
					<Input type="date" value={f.startedOn} onChange={(e) => set({ startedOn: e.target.value })} />
				</Field>
				{ended ? (
					<Field label="End date" error={problems.endedOn}>
						<Input type="date" value={f.endedOn} onChange={(e) => set({ endedOn: e.target.value })} />
					</Field>
				) : (
					<div className="flex flex-col gap-1.5">
						<span className="text-sm font-medium text-ink">End date</span>
						<p className="text-sm text-text-2">Held now. To end it, remove them from the ministry.</p>
					</div>
				)}
			</div>
			<Field label="Reason" error={problems.reason} hint="The ministry's history shows it with the old and new dates.">
				<Textarea rows={3} maxLength={500} value={f.reason} onChange={(e) => set({ reason: e.target.value })} />
			</Field>
		</RecordDialog>
	);
}

function correctionProblem(code: string) {
	if (code === "invalid_input")
		return "The dates or the reason are not valid. The end date cannot be before the start date, and a reason is required.";
	if (code === "conflict")
		return "Someone else changed this role since the page loaded. Reload the page to see the latest dates.";
	return problemText(code);
}
