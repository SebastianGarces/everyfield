"use client";

import { Button, Combobox, Field, Skeleton } from "@everyfield/ui/controls";
import { useState } from "react";
import { useRead } from "../../../components/read.tsx";
import { loadProblem } from "../../../components/read-failed.ts";
import type { LeadRead, PlantOwner } from "../port";
import { useWrite } from "../save";
import { SaveError } from "../SaveError";
import { useReads, useSettings } from "../store";

type Ready = Extract<LeadRead, { status: "ok" }>;

export function LeadPlanter({ plant, onSaved }: { plant: PlantOwner; onSaved: () => void }) {
	const lead = useRead(useReads().lead);
	const read = lead.value;
	if (!read) return <Skeleton shape="block" height={44} />;
	if (read.status !== "ok")
		return (
			<p className="text-md text-text-2">
				{read.status === "denied"
					? "Only this church's seats can see its lead planter."
					: loadProblem(read, "The lead planter couldn't load.")}
			</p>
		);
	const holder = read.lead?.holder ?? null;
	if (!read.canEdit)
		return (
			<div className="flex flex-wrap items-center gap-3">
				<span className={holder ? "font-medium text-ink" : "text-text-3"} data-lead-planter={holder?.personId ?? ""}>
					{holder?.name ?? "No lead planter named"}
				</span>
				{read.lead ? <span className="text-sm text-text-3">Only the Owner can change it.</span> : null}
			</div>
		);
	return (
		<LeadChooser
			key={`${read.revision}:${holder?.personId ?? ""}`}
			read={read}
			plant={plant}
			onSaved={() => {
				lead.retry();
				onSaved();
			}}
		/>
	);
}

function LeadChooser({ read, plant, onSaved }: { read: Ready; plant: PlantOwner; onSaved: () => void }) {
	const { port } = useSettings();
	const holder = read.lead?.holder ?? null;
	const [chosen, setChosen] = useState<string | null>(holder?.personId ?? null);
	const { pending, refusal, run } = useWrite("lead-planter");
	const changed = chosen !== null && chosen !== holder?.personId;
	const save = async () => {
		const person = read.people.find((p) => p.personId === chosen);
		if (!person) return;
		const input = { plant, personId: person.personId };
		const result = await run(input, (requestKey) =>
			port.lead.save({ requestKey, expectedRevision: read.revision, input }),
		);
		if (result.status === "ok") onSaved();
	};
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				<Field label={<span className="sr-only">Lead planter</span>} className="w-full max-w-[320px]">
					<Combobox
						options={read.people.map((p) => ({ value: p.personId, label: p.name }))}
						value={chosen ? [chosen] : []}
						onValueChange={(next) => next[0] && setChosen(next[0])}
						searchLabel="Search people"
						placeholder="Choose a person"
						emptyText="No one in your church matches."
					/>
				</Field>
				{changed ? (
					<Button size="sm" onClick={() => void save()} loading={pending}>
						Save lead planter
					</Button>
				) : null}
			</div>
			{refusal ? <SaveError message={refusal.message} reference={refusal.reference} /> : null}
		</div>
	);
}
