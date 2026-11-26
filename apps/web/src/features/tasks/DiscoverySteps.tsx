"use client";

import { setDiscoveryStepRequest, type discoverySteps } from "@everyfield/contracts/onboarding";
import { Card, Checkbox, InlineAlert, PageHeader } from "@everyfield/ui/controls";
import { useState } from "react";
import type { z } from "zod";
import { useIntent } from "../../components/intent.ts";
import { saveDiscoveryStep, type SavedSteps } from "./discovery-actions.ts";

type Steps = z.infer<typeof discoverySteps>;
type Command = z.infer<typeof setDiscoveryStepRequest>;

const PROBLEM = {
	refused: "That step changed somewhere else, so nothing was saved. Reload the page and try again.",
	unknown: "We couldn't save that step. Check your connection and try again.",
} as const;

export function DiscoverySteps({ initial }: { initial: Steps }) {
	const [steps, setSteps] = useState(initial);
	const [wanted, setWanted] = useState<{ key: string; done: boolean } | null>(null);
	const intent = useIntent<Command>("discovery-step");
	const done = steps.steps.filter((s) => s.doneAt !== null).length;
	const toggle = async (key: string, next: boolean) => {
		if (intent.pending !== null) return;
		setWanted({ key, done: next });
		const result = await intent.run(
			key,
			(requestKey) =>
				setDiscoveryStepRequest.parse({
					requestKey,
					expectedRevision: steps.revision,
					input: { discoveryId: steps.discoveryId, stepKey: key, done: next },
				}),
			saveDiscoveryStep,
			(reply: SavedSteps) => reply.status === "ok",
		);
		setWanted(null);
		if (result.ok && result.reply.status === "ok") setSteps(result.reply.steps);
	};
	return (
		<div className="flex flex-col gap-5">
			<PageHeader
				title="Tasks"
				subtitle="Your starter steps for the discovery season. Work through them in any order and check each one off as you go."
			/>
			<Card as="section" aria-labelledby="starter-steps-heading" className="max-w-[760px]">
				<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
					<h2 id="starter-steps-heading" className="font-sans text-md font-semibold tracking-normal text-ink">
						Starter steps
					</h2>
					<p className="text-sm text-text-2 tabular-nums" aria-live="polite">
						{done} of {steps.steps.length} done
					</p>
				</div>
				<ul className="mt-2 flex flex-col divide-y divide-line">
					{steps.steps.map((step) => {
						const saving = wanted?.key === step.key;
						const checked = saving ? wanted.done : step.doneAt !== null;
						return (
							<li key={step.key}>
								<Checkbox
									shape="round"
									label={step.title}
									description={step.description}
									checked={checked}
									disabled={intent.pending !== null}
									aria-busy={saving || undefined}
									className={saving ? "disabled:opacity-100" : undefined}
									onCheckedChange={(value) => void toggle(step.key, value === true)}
								/>
							</li>
						);
					})}
				</ul>
				<InlineAlert className="pt-3">{intent.problem ? PROBLEM[intent.problem] : null}</InlineAlert>
				<p className="mt-3 border-t border-line pt-3 text-sm text-text-2 text-pretty">
					When you start a church, these steps come with you as tasks. The ones you’ve checked off arrive done.
				</p>
			</Card>
		</div>
	);
}
