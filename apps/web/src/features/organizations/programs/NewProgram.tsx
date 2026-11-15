"use client";

import { RESIDENCY_TEMPLATE, type ProgramKind, type ProgramList } from "@everyfield/contracts/organizations";
import { Button, Card, CardBody, Field, Input, PageHeader, Radio, RadioGroup, Select } from "@everyfield/ui/controls";
import { useRouter } from "next/navigation";
import { useActionState, useState, type ReactNode } from "react";
import { PIPELINE_PATH } from "../board/model";
import { Problem } from "../board/Problem";
import { createProgram } from "./actions";
import { programHref, programProblem, PROGRAMS_PATH } from "./model";
import { PlanEditor, planFrom, type PlanDraft } from "./PlanEditor";

type Start = "template" | "blank";
type NewState = {
	values: { name: string; director: string };
	nameError: string | null;
	directorError: string | null;
	problem: string | null;
};

/** The residency template as an editable plan (REQ-MUL-010). */
function template(): PlanDraft {
	return {
		rhythm: "monthly",
		expectedMonths: "15",
		stages: RESIDENCY_TEMPLATE.stages.map((s) => ({
			key: crypto.randomUUID(),
			label: s.label,
			min: String(s.minMonths),
			max: String(s.maxMonths),
		})),
		milestones: RESIDENCY_TEMPLATE.milestones.map((title) => ({
			key: crypto.randomUUID(),
			lineage: crypto.randomUUID(),
			title,
			description: "",
			handsOn: false,
		})),
		readings: [],
	};
}
const blank = (): PlanDraft => ({ rhythm: "monthly", expectedMonths: "12", stages: [], milestones: [], readings: [] });

/**
 * A new apprenticeship or residency, from the residency template or from blank (REQ-MUL-010). An Owner or Admin
 * names it and its director; the plan saves as a draft that the director reviews and publishes.
 */
export function NewProgram({ list }: { list: ProgramList }) {
	const router = useRouter();
	const [programId] = useState(() => crypto.randomUUID());
	const [kind, setKind] = useState<ProgramKind>("residency");
	const [start, setStart] = useState<Start>("template");
	const [plan, setPlan] = useState<PlanDraft>(template);
	function choose(nextKind: ProgramKind, nextStart: Start) {
		const from = nextKind === "residency" ? nextStart : "blank";
		setKind(nextKind);
		setStart(from);
		setPlan(from === "template" ? template() : blank());
	}

	const [state, submit, saving] = useActionState(
		async (last: NewState, form: FormData): Promise<NewState> => {
			const values = { name: String(form.get("name") ?? ""), director: String(form.get("director") ?? "") };
			const built = planFrom(plan);
			const checked = {
				values,
				nameError: values.name.trim() ? null : "Name the program.",
				directorError: values.director ? null : "Choose who directs it.",
			};
			if (!values.name.trim() || !values.director || "problem" in built)
				return { ...checked, problem: "problem" in built ? built.problem : last.problem };
			const answer = await createProgram({
				programId,
				kind,
				name: values.name.trim(),
				directorSeatId: values.director,
				plan: built.plan,
			}).catch(() => ({ status: "lost" as const }));
			if (answer.status !== "ok") return { ...checked, problem: programProblem(answer) };
			router.push(programHref(programId));
			return { ...checked, problem: null };
		},
		{ values: { name: "", director: "" }, nameError: null, directorError: null, problem: null },
	);

	return (
		<form action={submit} noValidate className="flex flex-col gap-5">
			<PageHeader
				breadcrumb={[
					{ label: "Pipeline", href: PIPELINE_PATH },
					{ label: "Programs", href: PROGRAMS_PATH },
					{ label: "New program" },
				]}
				title="New program"
				subtitle="It saves as a draft. The director reviews the plan and publishes it before anyone is enrolled."
			/>
			<Card className="max-w-[880px]">
				<CardBody className="flex flex-col gap-6">
					<Choices legend="Kind">
						<RadioGroup
							aria-label="Kind"
							orientation="horizontal"
							value={kind}
							onValueChange={(v) => choose(v as ProgramKind, start)}
							className="flex-wrap"
						>
							<Radio id="kind-residency" value="residency" label="Residency" />
							<Radio id="kind-apprenticeship" value="apprenticeship" label="Apprenticeship" />
						</RadioGroup>
					</Choices>
					{kind === "residency" ? (
						<Choices legend="Start from">
							<RadioGroup aria-label="Start from" value={start} onValueChange={(v) => choose(kind, v as Start)}>
								<Radio
									id="start-template"
									value="template"
									label="Residency template"
									description="Four stages with month ranges and three starter milestones. You can change any of them."
								/>
								<Radio id="start-blank" value="blank" label="Blank" description="No stages or milestones yet." />
							</RadioGroup>
						</Choices>
					) : null}
					<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
						<Field label="Name" error={state.nameError ?? undefined}>
							<Input
								name="name"
								defaultValue={state.values.name}
								maxLength={120}
								autoComplete="off"
								placeholder={kind === "residency" ? "Church planting residency" : "Apprenticeship"}
							/>
						</Field>
						<Field
							label="Director"
							hint="They edit and publish the plan and record milestones."
							error={state.directorError ?? undefined}
						>
							<Select
								name="director"
								defaultValue={state.values.director}
								placeholder="Choose a staff member"
								options={list.staff.map((s) => ({ value: s.seatId, label: s.name }))}
							/>
						</Field>
					</div>
					<PlanEditor value={plan} onChange={setPlan} />
					<Problem text={saving ? null : state.problem} />
					<div className="flex justify-end">
						<Button type="submit" variant="primary" loading={saving}>
							Save draft
						</Button>
					</div>
				</CardBody>
			</Card>
		</form>
	);
}

function Choices({ legend, children }: { legend: string; children: ReactNode }) {
	return (
		<fieldset className="flex min-w-0 flex-col">
			<legend className="text-sm font-medium text-ink-2">{legend}</legend>
			{children}
		</fieldset>
	);
}
