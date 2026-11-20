"use client";

import { Certificate01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	IntentLink,
	Spinner,
	StatePanel,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { useState } from "react";
import { localToday } from "../../../components/clock.ts";
import { createRead, useRead } from "../../../components/read.tsx";
import { PersonPicker } from "../../meetings/dialogs.tsx";
import { dayText, plural } from "../model.ts";
import { loadPersonTraining } from "../fetch.ts";
import {
	latestByProgram,
	personForm,
	problemText,
	serviceForm,
	type Credit,
	type Flow,
	type PersonLoad,
	type ShownProgram,
} from "./model.ts";
import { loadProblem, failedIcon } from "../../../components/read-failed.ts";
import type { ReadFailure } from "../../../components/get-reads.ts";

type Loaded = { [K in keyof PersonLoad]: PersonLoad[K] | ReadFailure };
type PersonRead = { status: "ok"; value: Loaded } | { status: "lost" };

const personTraining = createRead(
	({ personId }: { personId: string; tick: number }): Promise<PersonRead> =>
		loadPersonTraining(personId).then((value) => ({ status: "ok", value })),
	{ failed: (): PersonRead => ({ status: "lost" }) },
);

export function PersonLookup({
	programs,
	canRecordService,
	canWrite,
	busy,
	tick,
	onOpen,
}: {
	programs: readonly ShownProgram[];
	canRecordService: boolean;
	canWrite: (program: ShownProgram) => boolean;
	busy: boolean;
	tick: number;
	onOpen: (form: Flow) => void;
}) {
	const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
	const training = useRead(person ? personTraining : null, { personId: person?.id ?? "", tick });
	const ready = training.value;
	const choose = (next: { id: string; name: string } | null) => {
		if (next) personTraining.prefetch({ personId: next.id, tick });
		setPerson(next);
	};

	return (
		<Card as="section" aria-labelledby="person-training-title">
			<CardHeader>
				<CardHeading>
					<CardTitle id="person-training-title" size="sm">
						One person
					</CardTitle>
					<CardDescription>Look up what they have finished, then record, revoke, or record it again.</CardDescription>
				</CardHeading>
			</CardHeader>
			<PersonPicker label="Person" value={person} onChange={choose} />
			{person ? (
				<div className="mt-6 flex flex-col gap-6">
					<IntentLink
						href={`/people/${person.id}`}
						className="self-start rounded-sm text-sm font-medium text-ink underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
					>
						Open their person page
					</IntentLink>
					{ready?.status === "lost" ? (
						<StatePanel
							tone="error"
							title="Training for this person did not load"
							headingLevel="h3"
							actions={
								<Button variant="secondary" onClick={training.retry}>
									Try again
								</Button>
							}
						>
							Nothing was changed.
						</StatePanel>
					) : !ready ? (
						<p role="status" className="flex items-center gap-2 text-sm text-text-3">
							<Spinner size={16} /> Loading training for this person…
						</p>
					) : (
						<PersonResult
							person={person}
							load={ready.value}
							programs={programs}
							canRecordService={canRecordService}
							canWrite={canWrite}
							busy={busy}
							onOpen={onOpen}
							onRetry={training.retry}
						/>
					)}
				</div>
			) : (
				<p className="mt-4 text-sm text-text-3">Choose a person to see their training.</p>
			)}
		</Card>
	);
}

function PersonResult({
	person,
	load,
	programs,
	canRecordService,
	canWrite,
	busy,
	onOpen,
	onRetry,
}: {
	person: { id: string; name: string };
	load: Loaded;
	programs: readonly ShownProgram[];
	canRecordService: boolean;
	canWrite: (program: ShownProgram) => boolean;
	busy: boolean;
	onOpen: (form: Flow) => void;
	onRetry: () => void;
}) {
	const summary = load.summary;
	const credits = load.credits;
	return (
		<div className="flex flex-col gap-6">
			{summary.status === "ok" ? (
				<Summary summary={summary.value} />
			) : (
				<StatePanel
					tone="error"
					title="The summary did not load"
					icon={failedIcon(summary)}
					headingLevel="h3"
					actions={
						<Button variant="secondary" onClick={onRetry}>
							Try again
						</Button>
					}
				>
					{summary.status === "refused"
						? problemText(summary.code)
						: loadProblem(summary, "Nothing was changed. Try again in a moment.")}
				</StatePanel>
			)}
			{credits.status === "ok" ? (
				<History
					person={person}
					credits={credits.value}
					programs={programs}
					canRecordService={canRecordService}
					canWrite={canWrite}
					busy={busy}
					onOpen={onOpen}
				/>
			) : (
				<StatePanel
					tone="error"
					title="The history did not load"
					icon={failedIcon(credits)}
					headingLevel="h3"
					actions={
						<Button variant="secondary" onClick={onRetry}>
							Try again
						</Button>
					}
				>
					{credits.status === "refused"
						? problemText(credits.code)
						: loadProblem(credits, "Nothing was changed. Try again in a moment.")}
				</StatePanel>
			)}
		</div>
	);
}

function Summary({ summary }: { summary: Extract<PersonLoad["summary"], { status: "ok" }>["value"] }) {
	const complete = summary.currentTrainingComplete;
	return (
		<div className="flex flex-col gap-3">
			<h3 className="font-title text-title-sm tracking-[-0.02em] text-ink">Where they serve</h3>
			{summary.currentTeams.length === 0 && summary.formerTeams.length === 0 ? (
				<p className="text-sm text-text-2">No ministry is recorded.</p>
			) : (
				<ul className="flex flex-col gap-1 text-sm text-text-2">
					{summary.currentTeams.map((name) => (
						<li key={`now-${name}`}>{name}</li>
					))}
					{summary.formerTeams.map((name) => (
						<li key={`was-${name}`}>Former: {name}</li>
					))}
				</ul>
			)}
			<p className="text-sm text-text-2">{plural(summary.concurrentAssignments, "current role")}</p>
			<div className="flex flex-col items-start gap-2">
				<StatusBadge status={complete ? "positive" : "unknown"}>
					{complete ? "Required training is complete" : "Not marked complete"}
				</StatusBadge>
				<p className="text-sm text-text-2">
					{complete
						? "Every assigned required program has a current completion."
						: "Required training is not marked complete. A person with no required program also reads this way."}
				</p>
			</div>
		</div>
	);
}

function History({
	person,
	credits,
	programs,
	canRecordService,
	canWrite,
	busy,
	onOpen,
}: {
	person: { id: string; name: string };
	credits: readonly Credit[];
	programs: readonly ShownProgram[];
	canRecordService: boolean;
	canWrite: (program: ShownProgram) => boolean;
	busy: boolean;
	onOpen: (form: Flow) => void;
}) {
	const byId = new Map<string, ShownProgram>(programs.map((program) => [program.id, program]));
	const latest = latestByProgram(credits);
	const ids = new Set<string>();
	for (const credit of credits) if (credit.programId) ids.add(credit.programId);
	for (const program of programs) {
		if (program.rosterKnown && program.assignedIds.includes(person.id)) ids.add(program.id);
	}
	const rows = [...ids]
		.map((id) => ({ id, program: byId.get(id) ?? null, credit: latest.get(id) ?? null }))
		.sort(
			(a, b) =>
				(a.program?.name ?? "A program").localeCompare(b.program?.name ?? "A program") || a.id.localeCompare(b.id),
		);
	const service = credits
		.filter((credit) => credit.kind === "service")
		.slice()
		.reverse();
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-3">
				<h3 className="font-title text-title-sm tracking-[-0.02em] text-ink">Training history</h3>
				{rows.length === 0 ? (
					<p className="text-sm text-text-2">No program is recorded for this person.</p>
				) : (
					<ul className="flex flex-col">
						{rows.map((row) => (
							<li key={row.id} className="flex flex-col gap-3 border-t border-line py-4 first:border-t-0 first:pt-0">
								<ProgramHistory
									row={row}
									credits={credits}
									person={person}
									canWrite={canWrite}
									busy={busy}
									onOpen={onOpen}
								/>
							</li>
						))}
					</ul>
				)}
				{credits.length === 200 ? (
					<p className="text-sm text-text-3">The oldest records are not all shown. 200 are listed.</p>
				) : null}
			</div>
			<div className="flex flex-col gap-3">
				<h3 className="font-title text-title-sm tracking-[-0.02em] text-ink">Attendance and serving</h3>
				<p className="text-sm text-text-2">
					60 days of each can invite a leadership conversation. It does not change their stage or finish a program.
				</p>
				{service.length === 0 ? (
					<p className="text-sm text-text-2">None is recorded.</p>
				) : (
					<ul className="flex flex-col gap-2">
						{service.map((credit) => (
							<li key={credit.id} className="text-sm text-text-2">
								Attendance {credit.attendanceDays ?? 0} days. Serving {credit.volunteerDays ?? 0} days.
							</li>
						))}
					</ul>
				)}
				{canRecordService ? (
					<Button
						variant="outline"
						icon={Certificate01Icon}
						disabled={busy}
						onClick={() => onOpen(serviceForm(person))}
					>
						Record attendance and serving
					</Button>
				) : null}
			</div>
		</div>
	);
}

function ProgramHistory({
	row,
	credits,
	person,
	canWrite,
	busy,
	onOpen,
}: {
	row: { id: string; program: ShownProgram | null; credit: Credit | null };
	credits: readonly Credit[];
	person: { id: string; name: string };
	canWrite: (program: ShownProgram) => boolean;
	busy: boolean;
	onOpen: (form: Flow) => void;
}) {
	const name = row.program?.name ?? "A program";
	const writable = row.program ? canWrite(row.program) : false;
	const events = credits
		.filter((credit) => credit.programId === row.id)
		.slice()
		.reverse();
	const earned = row.credit?.kind === "earned";
	return (
		<>
			<div className="flex flex-col gap-1">
				<h4 className="font-medium text-ink">{name}</h4>
				<p className="text-sm text-text-2">{latestText(row.credit)}</p>
			</div>
			{events.length > 1 ? (
				<ul className="flex flex-col gap-1">
					{events.map((credit) => (
						<li key={credit.id} className="text-sm text-text-3">
							{eventText(credit)}
						</li>
					))}
				</ul>
			) : null}
			{writable && row.program ? (
				<div className="flex flex-wrap gap-2">
					{earned ? (
						<>
							<Button
								variant="danger"
								disabled={busy}
								onClick={() => onOpen(personForm("revoke", localToday(), row.program!, person))}
							>
								Revoke completion
							</Button>
							<Button
								variant="outline"
								disabled={busy}
								onClick={() => onOpen(personForm("redo", localToday(), row.program!, person))}
							>
								Record again
							</Button>
						</>
					) : (
						<Button
							variant="primary"
							disabled={busy}
							onClick={() => onOpen(personForm("complete", localToday(), row.program!, person))}
						>
							Record completion
						</Button>
					)}
				</div>
			) : null}
		</>
	);
}

function latestText(credit: Credit | null): string {
	if (!credit) return "No completion is recorded.";
	if (credit.kind === "earned") return `Completed on ${credit.earnedOn ? dayText(credit.earnedOn) : "a recorded day"}.`;
	return "Revoked. The earlier completion stays in the history.";
}

function eventText(credit: Credit): string {
	const version = credit.version ? ` Version ${credit.version}.` : "";
	if (credit.kind === "earned")
		return `Completed on ${credit.earnedOn ? dayText(credit.earnedOn) : "a recorded day"}.${version}`;
	return `Revoked.${version}`;
}
