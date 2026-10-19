"use client";

import { UserAdd01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	Select,
} from "@everyfield/ui/controls";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { createPerson } from "./actions.ts";
import {
	CLASSIFICATION_LABEL,
	CLASSIFICATIONS,
	PersonStore,
	runSave,
	SOURCE_LABEL,
	SOURCES,
	STAGE_LABEL,
	STAGES,
} from "./model.ts";
import { FormProblem, fresh, useStore } from "./parts.tsx";

type Draft = {
	displayName: string;
	email: string;
	phone: string;
	country: string;
	stage: string;
	source: string;
	adultClassification: string;
};
const EMPTY: Draft = {
	displayName: "",
	email: "",
	phone: "",
	country: "US",
	stage: "prospect",
	source: "other",
	adultClassification: "unknown",
};
const blankToNull = (v: string) => (v.trim() === "" ? null : v.trim());

/**
 * Add person (REQ-PPL-002 quick add): one real display name, optional email and phone, and the defaults the product
 * names (prospect, source other, country US, adult classification not recorded). Nothing here links an account or
 * records a commitment. The draft stays if the dialog closes by accident; Cancel asks nothing because nothing is lost
 * that matters more than a name.
 */
export function AddPersonDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const router = useRouter();
	const store = useMemo(() => new PersonStore<{ revision: string }, Draft>({ revision: "0" }), []);
	const state = useStore(store);
	const draft = state.drafts.add ?? EMPTY;
	const pending = state.pending === "add";
	const [touched, setTouched] = useState(false);
	const set = (patch: Partial<Draft>) => store.dispatch({ type: "edit", slot: "add", draft: { ...draft, ...patch } });
	const nameMissing = draft.displayName.trim() === "";

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setTouched(true);
		if (nameMissing) return;
		const input = {
			displayName: draft.displayName.trim(),
			email: blankToNull(draft.email),
			phone: blankToNull(draft.phone),
			country: blankToNull(draft.country),
			stage: draft.stage,
			source: draft.source,
			adultClassification: draft.adultClassification,
		};
		const result = await runSave(store, "add", input, (key) => createPerson(key, input), { fresh });
		if (result?.status === "ok") {
			setTouched(false);
			onOpenChange(false);
			router.push(`/people/${result.value.personId}`);
		}
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
			<DialogContent aria-busy={pending || undefined}>
				<form onSubmit={submit} noValidate className="contents">
					<DialogHeader
						icon={UserAdd01Icon}
						tone="green"
						title="Add a person"
						description="Start with a name. You can add the rest later."
					/>
					<DialogBody className="flex flex-col gap-4">
						<Field label="Name" error={touched && nameMissing ? "Enter the name people call them." : null}>
							<Input
								value={draft.displayName}
								readOnly={pending}
								maxLength={255}
								autoComplete="off"
								onChange={(e) => set({ displayName: e.target.value })}
								autoFocus
							/>
						</Field>
						<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
							<Field label="Email" optional>
								<Input
									type="email"
									value={draft.email}
									readOnly={pending}
									maxLength={320}
									autoComplete="off"
									onChange={(e) => set({ email: e.target.value })}
								/>
							</Field>
							<Field label="Phone" optional>
								<Input
									type="tel"
									value={draft.phone}
									readOnly={pending}
									maxLength={255}
									autoComplete="off"
									onChange={(e) => set({ phone: e.target.value })}
								/>
							</Field>
							<Field label="Stage">
								<Select
									value={draft.stage}
									disabled={pending}
									onValueChange={(stage) => set({ stage })}
									options={STAGES.map((s) => ({ value: s, label: STAGE_LABEL[s] }))}
								/>
							</Field>
							<Field label="How you met">
								<Select
									value={draft.source}
									disabled={pending}
									onValueChange={(source) => set({ source })}
									options={SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))}
								/>
							</Field>
							<Field label="Adult or child" hint="Leave as not recorded until you know.">
								<Select
									value={draft.adultClassification}
									disabled={pending}
									onValueChange={(adultClassification) => set({ adultClassification })}
									options={CLASSIFICATIONS.map((c) => ({ value: c, label: CLASSIFICATION_LABEL[c] }))}
								/>
							</Field>
							<Field label="Country" optional hint="Two-letter code, such as US.">
								<Input
									value={draft.country}
									readOnly={pending}
									maxLength={255}
									autoComplete="off"
									onChange={(e) => set({ country: e.target.value })}
								/>
							</Field>
						</div>
						<FormProblem code={state.errors.add} />
					</DialogBody>
					<DialogFooter>
						<Button variant="secondary" type="button" onClick={() => onOpenChange(false)} disabled={pending}>
							Cancel
						</Button>
						<Button variant="primary" type="submit" loading={pending}>
							Add person
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
