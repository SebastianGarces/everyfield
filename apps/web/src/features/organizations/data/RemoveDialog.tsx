"use client";

import type { PipelineRemovalReport } from "@everyfield/contracts/organizations";
import { Alert02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@everyfield/ui/controls";
import Link from "next/link";
import { useState } from "react";
import { PIPELINE_PATH, refusalText } from "../board/model";
import { Problem } from "../board/Problem";
import { removePerson } from "./actions";
import { keptText, removedLines } from "./model";

// Removal on request (REQ-MUL-005). The first step says it cannot be undone and how it differs from retiring; nothing
// changes until the Owner or Admin confirms. The second shows what was removed and what the organization kept and why.

type Person = { personId: string; revision: string; name: string };

export function RemoveDialog({
	open,
	onOpenChange,
	person,
	organization,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	person: Person;
	organization: string;
}) {
	const [pending, setPending] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [report, setReport] = useState<PipelineRemovalReport | null>(null);

	const confirm = async () => {
		setPending(true);
		setProblem(null);
		const answer = await removePerson({ personId: person.personId, expectedRevision: person.revision }).catch(
			() => ({ status: "lost" }) as const,
		);
		setPending(false);
		if (answer.status === "ok") setReport(answer.value);
		else setProblem(refusalText(answer));
	};

	// Once removed there is no record to go back to: the dialog stays until the person leaves for the board.
	const change = (next: boolean) => {
		if (pending || report) return;
		setProblem(null);
		onOpenChange(next);
	};

	return (
		<Dialog open={open || report !== null} onOpenChange={change}>
			<DialogContent size="md" aria-busy={pending || undefined}>
				{report ? (
					<>
						<DialogHeader
							icon={Tick02Icon}
							tone="green"
							closable={false}
							title={`${person.name} was removed`}
							description={`Their name and contact details are gone from ${organization}’s pipeline.`}
						/>
						<DialogBody className="flex flex-col gap-5">
							<section aria-labelledby="removed-heading">
								<h3 id="removed-heading" className="text-sm font-medium text-ink">
									Removed
								</h3>
								<ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-md text-text-2">
									{removedLines(report).map((line) => (
										<li key={line}>{line}</li>
									))}
								</ul>
							</section>
							<section aria-labelledby="kept-heading">
								<h3 id="kept-heading" className="text-sm font-medium text-ink">
									What {organization} kept, and why
								</h3>
								<ul className="mt-1.5 flex flex-col gap-2.5">
									{report.kept.map((k) => {
										const { title, why } = keptText(k, report.attribution);
										return (
											<li key={k.category} className="rounded-md bg-surface-2 px-3 py-2.5">
												<p className="text-sm font-medium text-ink">{title}</p>
												<p className="mt-0.5 text-sm text-text-2 text-pretty">{why}</p>
											</li>
										);
									})}
								</ul>
								<p className="mt-3 text-sm text-text-2 text-pretty">
									None of this has a deletion date: it stays only because {organization} needs it without {person.name}.
								</p>
							</section>
						</DialogBody>
						<DialogFooter>
							<Button variant="primary" asChild>
								<Link href={PIPELINE_PATH}>Back to Pipeline</Link>
							</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<DialogHeader
							icon={Alert02Icon}
							tone="magenta"
							title={`Remove ${person.name} on request?`}
							description={`Use this when ${person.name} asks ${organization} to remove them. It can’t be undone.`}
						/>
						<DialogBody className="flex flex-col gap-4 text-md text-text-2">
							<p className="text-pretty">
								<span className="font-medium text-ink">Removed:</span> their name and contact details, their place on
								the pipeline and stage history, staff notes, conversations, enrollments in progress, milestone marks and
								feedback. If they have an Everyfield account, their link to {organization} ends at once; their own
								account stays as it is.
							</p>
							<p className="text-pretty">
								<span className="font-medium text-ink">Kept, without their name:</span> finished programs as counts, the
								activity record with names and values taken out, and a record of this removal.
							</p>
							<p className="rounded-md bg-surface-2 px-3 py-2.5 text-sm text-pretty">
								Not the same as retiring. Retire takes someone off the board but keeps their record, so you can restore
								them later.
							</p>
							<Problem text={problem} />
						</DialogBody>
						<DialogFooter>
							<Button variant="ghost" disabled={pending} onClick={() => change(false)}>
								Cancel
							</Button>
							<Button variant="danger" loading={pending} onClick={confirm}>
								Remove {person.name}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
