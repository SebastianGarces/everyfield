"use client";

import { Checkbox, Field, Input } from "@everyfield/ui/controls";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { basicsProblems, type BasicsDraft } from "../model";
import { StepFooter } from "../parts";

/**
 * Church basics: a required name and an optional, independent place (REQ-IDN-013), plus the account owner's own
 * confirmation (REQ-MUL-006). Nothing is sent until the name is filled and the box is ticked.
 */
export function BasicsForm({
	draft,
	onEdit,
	onSubmit,
	busy,
	onBack,
	submitLabel,
	children,
}: {
	draft: BasicsDraft;
	onEdit: (draft: BasicsDraft) => void;
	onSubmit: () => void;
	busy: boolean;
	onBack?: () => void;
	submitLabel: string;
	/** Extra fields between the place and the confirmation, such as relationships to bring. */
	children?: ReactNode;
}) {
	const [shown, setShown] = useState<ReturnType<typeof basicsProblems>>({});
	const nameRef = useRef<HTMLInputElement>(null);
	const confirmRef = useRef<HTMLButtonElement>(null);
	const set = (patch: Partial<BasicsDraft>) => onEdit({ ...draft, ...patch });

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const problems = basicsProblems(draft);
		setShown(problems);
		if (problems.name) return nameRef.current?.focus();
		if (problems.confirmed) return confirmRef.current?.focus();
		onSubmit();
	}

	return (
		<form noValidate onSubmit={submit} className="mx-auto mt-[34px] max-w-[620px]">
			<div className="flex flex-col gap-4 rounded-[18px] border border-line bg-surface-raised p-6 shadow-card">
				<Field label="Church name" error={shown.name}>
					<Input
						ref={nameRef}
						name="name"
						autoComplete="organization"
						maxLength={200}
						value={draft.name}
						onChange={(e) => {
							set({ name: e.target.value });
							if (shown.name && e.target.value.trim()) setShown({ ...shown, name: undefined });
						}}
					/>
				</Field>
				<fieldset className="flex flex-col gap-4">
					<legend className="mb-1 text-sm font-medium text-ink-2">
						Where it is <span className="font-normal text-text-3">(optional)</span>
					</legend>
					<p className="-mt-3 text-xs text-text-3">Fill in any part. We never guess the rest.</p>
					<div className="grid gap-4 sm:grid-cols-3">
						<Field label="City">
							<Input
								name="city"
								autoComplete="address-level2"
								maxLength={200}
								value={draft.city}
								onChange={(e) => set({ city: e.target.value })}
							/>
						</Field>
						<Field label="State or province">
							<Input
								name="stateProvince"
								autoComplete="address-level1"
								maxLength={200}
								value={draft.stateProvince}
								onChange={(e) => set({ stateProvince: e.target.value })}
							/>
						</Field>
						<Field label="Country">
							<Input
								name="country"
								autoComplete="country-name"
								maxLength={200}
								value={draft.country}
								onChange={(e) => set({ country: e.target.value })}
							/>
						</Field>
					</div>
				</fieldset>
				{children}
				<div>
					<Checkbox
						ref={confirmRef}
						checked={draft.confirmed}
						onCheckedChange={(checked) => {
							set({ confirmed: checked === true });
							if (checked === true) setShown({ ...shown, confirmed: undefined });
						}}
						aria-invalid={shown.confirmed ? true : undefined}
						aria-describedby={shown.confirmed ? "basics-confirm-error" : undefined}
						label="I’m setting up this church myself"
						description="You become its Owner. No one else, including a sending church, can set it up for you."
					/>
					{shown.confirmed ? (
						<p id="basics-confirm-error" className="text-xs font-medium text-magenta-600">
							{shown.confirmed}
						</p>
					) : null}
				</div>
			</div>
			<StepFooter onBack={onBack} busy={busy} continueType="submit" continueLabel={submitLabel} />
		</form>
	);
}
