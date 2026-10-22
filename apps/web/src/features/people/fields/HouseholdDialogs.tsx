"use client";

import { Copy01Icon, Home01Icon, Logout01Icon } from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import { Checkbox, Field, Input, Radio, RadioGroup, SearchInput, Select, Spinner } from "@everyfield/ui/controls";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type { Outcome, Wait } from "../../../components/save/model.ts";
import { RecordDialog } from "../../../components/save/parts.tsx";
import { problemText } from "../parts.tsx";
import { findHouseholds } from "./actions.ts";
import { addressLine, ROLE_LABEL, ROLES, type Household, type HouseholdRole, type HouseholdSummary } from "./model.ts";

type PlantPerson = z.infer<typeof people.plantPerson>;
type Address = { street: string; city: string; stateProvince: string; postalCode: string; country: string };
/**
 * What every household dialog takes. The card closes the dialog at once and shows the expected result; a refused change
 * opens the dialog again with the same values (`initial`) and the reason (`problem`). While the card's last save is in
 * flight or unknown (`wait`, C68) the form keeps its values and cannot submit.
 */
type FormProps<T> = {
	onClose: () => void;
	onSubmit: (value: T) => void;
	initial?: T;
	problem?: string;
	wait: Wait;
};
type AddressValue = { [K in keyof Address]: string | null };
export type StartValue = { name: string } & AddressValue;
export type EditValue = { name?: string } & AddressValue;
export type JoinValue = { householdId: string; role: HouseholdRole; household: HouseholdSummary };
export type LeaveValue = { deleteEmpty: boolean };

const ADDRESS: (keyof Address)[] = ["street", "city", "stateProvince", "postalCode", "country"];
const ADDRESS_LABEL: Record<keyof Address, string> = {
	street: "Street",
	city: "City",
	stateProvince: "State or province",
	postalCode: "Postal code",
	country: "Country",
};
const addressDraft = (a: { [K in keyof Address]?: string | null }): Address => ({
	street: a.street ?? "",
	city: a.city ?? "",
	stateProvince: a.stateProvince ?? "",
	postalCode: a.postalCode ?? "",
	country: a.country ?? "",
});
const addressValue = (a: Address) =>
	Object.fromEntries(ADDRESS.map((k) => [k, a[k].trim() || null])) as { [K in keyof Address]: string | null };

/** The words for a refused household change. */
export function householdProblem(code: string, first: string): string {
	switch (code) {
		case "busy":
			return "Another change to this person was still saving, so nothing was sent. Try again when it ends.";
		case "conflict":
			return "This household or person changed while you were working. The latest details show now. Check them and try again.";
		case "invalid_subject":
			return `${first} is already in a household, or that household cannot take them. Take them out of their household first.`;
		default:
			return problemText(code);
	}
}

function AddressFields({ value, onChange }: { value: Address; onChange: (a: Address) => void }) {
	return (
		<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
			{ADDRESS.map((k) => (
				<Field
					key={k}
					label={ADDRESS_LABEL[k]}
					optional
					className={k === "street" ? "col-span-2 max-app-sm:col-span-1" : undefined}
				>
					<Input
						value={value[k]}
						maxLength={255}
						autoComplete="off"
						onChange={(e) => onChange({ ...value, [k]: e.target.value })}
					/>
				</Field>
			))}
		</div>
	);
}

/** A default household name from the person's last name: "Maria Santos" starts "Santos household". */
const defaultName = (p: PlantPerson) => `${p.lastName?.trim() || p.displayName.trim().split(/\s+/).at(-1)} household`;

/** Start a household with this person as its head (REQ-PPL-009). The address starts as the person's own. */
export function StartHouseholdDialog({
	person,
	onClose,
	onSubmit,
	initial,
	problem,
	wait,
}: { person: PlantPerson } & FormProps<StartValue>) {
	const [name, setName] = useState(initial?.name ?? defaultName(person));
	const [address, setAddress] = useState(addressDraft(initial ?? person));
	const [touched, setTouched] = useState(false);
	const missing = name.trim() === "";
	return (
		<RecordDialog
			icon={Home01Icon}
			tone="green"
			title="Start a household"
			description={`${person.displayName} will be its head. You can add the others next.`}
			action="Start household"
			onClose={onClose}
			problem={problem}
			wait={wait}
			onSubmit={() => {
				setTouched(true);
				if (!missing) onSubmit({ name: name.trim(), ...addressValue(address) });
				return !missing;
			}}
		>
			<Field label="Household name" error={touched && missing ? "Name the household, such as Santos household." : null}>
				<Input value={name} maxLength={255} onChange={(e) => setName(e.target.value)} />
			</Field>
			<AddressFields value={address} onChange={setAddress} />
		</RecordDialog>
	);
}

/** Edit a household's name and address. Members keep their own addresses until someone copies it on purpose. */
export function EditHouseholdDialog({
	household,
	onClose,
	onSubmit,
	initial,
	problem,
	wait,
}: { household: Household } & FormProps<EditValue>) {
	const h = household.household;
	const [name, setName] = useState(initial?.name ?? h.name);
	const [address, setAddress] = useState(addressDraft(initial ?? h));
	const [touched, setTouched] = useState(false);
	const missing = name.trim() === "";
	return (
		<RecordDialog
			icon={Home01Icon}
			tone="blue"
			title={`Edit ${h.name}`}
			description="Members keep their own addresses. To give everyone this address, use Copy address to members."
			action="Save household"
			onClose={onClose}
			problem={problem}
			wait={wait}
			onSubmit={() => {
				setTouched(true);
				if (missing) return false;
				onSubmit({ ...(name.trim() !== h.name ? { name: name.trim() } : {}), ...addressValue(address) });
				return true;
			}}
		>
			<Field label="Household name" error={touched && missing ? "Name the household." : null}>
				<Input value={name} maxLength={255} onChange={(e) => setName(e.target.value)} />
			</Field>
			<AddressFields value={address} onChange={setAddress} />
		</RecordDialog>
	);
}

/**
 * Add this person to an existing household with a role. A person with no address of their own takes the household's;
 * an address they already have stays (REQ-PPL-009).
 */
export function JoinHouseholdDialog({
	person,
	onClose,
	onSubmit,
	initial,
	problem,
	wait,
}: { person: PlantPerson } & FormProps<JoinValue>) {
	const first = person.displayName.split(" ")[0] ?? person.displayName;
	const [search, setSearch] = useState("");
	const [found, setFound] = useState<Outcome<{ items: HouseholdSummary[]; total: number }> | null>(null);
	const [choice, setChoice] = useState<string>(initial?.householdId ?? "");
	const [role, setRole] = useState<HouseholdRole | "">(initial?.role ?? "");
	const [touched, setTouched] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const term = useRef("");

	function load(q: string) {
		term.current = q;
		findHouseholds(q)
			.catch(() => ({ status: "lost" }) as const)
			.then((r) => term.current === q && setFound(r));
	}
	useEffect(() => {
		load("");
		return () => clearTimeout(timer.current);
	}, []);

	const items = found?.status === "ok" ? found.value.items : [];
	const chosen = items.find((h) => h.id === choice);
	return (
		<RecordDialog
			icon={Home01Icon}
			tone="green"
			title={`Add ${first} to a household`}
			description={
				person.street || person.city
					? `${first} keeps their own address.`
					: `${first} has no address yet, so they take the household's address.`
			}
			action="Add to household"
			onClose={onClose}
			problem={problem}
			wait={wait}
			onSubmit={() => {
				setTouched(true);
				if (!chosen || !role) return false;
				onSubmit({ householdId: chosen.id, role, household: chosen });
				return true;
			}}
		>
			<SearchInput
				aria-label="Search households"
				placeholder="Search households"
				value={search}
				maxLength={255}
				onChange={(e) => {
					const q = e.target.value;
					setSearch(q);
					clearTimeout(timer.current);
					timer.current = setTimeout(() => load(q.trim()), 250);
				}}
			/>
			<div className="max-h-[260px] min-h-[120px] overflow-y-auto rounded-md shadow-[0_0_0_1px_var(--ef-line)]">
				{found === null ? (
					<div className="flex items-center gap-2.5 px-4 py-4 text-sm text-text-3" role="status">
						<Spinner size={14} />
						Loading households…
					</div>
				) : found.status !== "ok" ? (
					<p role="alert" className="px-4 py-4 text-sm text-text-2">
						Households did not load.{" "}
						<button
							type="button"
							className="cursor-pointer font-medium text-ink underline"
							onClick={() => load(search.trim())}
						>
							Try again
						</button>
					</p>
				) : items.length === 0 ? (
					<p className="px-4 py-4 text-sm text-text-3">
						{search.trim() ? "No household has that name." : "Your church has no households yet. Start one instead."}
					</p>
				) : (
					<RadioGroup
						aria-label="Household"
						aria-invalid={(touched && !choice) || undefined}
						aria-describedby={touched && !choice ? "household-choice-error" : undefined}
						value={choice}
						onValueChange={setChoice}
						className="gap-0 px-4"
					>
						{items.map((h) => (
							<Radio
								key={h.id}
								value={h.id}
								className="border-t border-line first:border-t-0"
								label={h.name}
								description={[
									h.memberCount === 0 ? "No members" : `${h.memberCount} ${h.memberCount === 1 ? "member" : "members"}`,
									addressLine(h),
								]
									.filter(Boolean)
									.join(" · ")}
							/>
						))}
					</RadioGroup>
				)}
			</div>
			{touched && !choice ? (
				<p id="household-choice-error" className="text-xs font-medium text-magenta-600">
					Choose a household.
				</p>
			) : null}
			{found?.status === "ok" && found.value.total > items.length ? (
				<p className="text-xs text-text-3">
					Showing {items.length} of {found.value.total}. Search to narrow the list.
				</p>
			) : null}
			<Field
				label={chosen ? `${first}'s role in ${chosen.name}` : `${first}'s role`}
				hint="A household role is a fact about the home. It does not record adult or child."
				error={touched && !role ? "Choose a role." : null}
			>
				<Select
					value={role}
					placeholder="Choose a role"
					onValueChange={(r) => setRole(r as HouseholdRole)}
					options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
				/>
			</Field>
		</RecordDialog>
	);
}

/**
 * Copy the household address to every member (REQ-PPL-009): a preview read fresh when the dialog opens shows each
 * member's address now and which ones change. Confirming overwrites exactly those reviewed members at once; if anyone
 * changed since the preview, nothing is written.
 */
export function CopyAddressDialog({
	household: h,
	onClose,
	onSubmit,
	problem,
	wait,
}: {
	/** The household as the card shows it now; the server refuses the copy if anyone changed since. */
	household: Household;
} & FormProps<Household>) {
	const target = addressLine(h.household);
	const changes = h.members.filter((m) => addressLine(m) !== target);
	return (
		<RecordDialog
			icon={Copy01Icon}
			tone="blue"
			title="Copy address to members"
			description="Every member below gets the household address. Check the list first."
			action={
				changes.length ? `Copy to ${changes.length} ${changes.length === 1 ? "person" : "people"}` : "Copy address"
			}
			onClose={onClose}
			problem={problem}
			wait={wait}
			disabled={!target || changes.length === 0}
			onSubmit={() => {
				onSubmit(h);
				return true;
			}}
		>
			{!target ? (
				<p className="text-sm text-text-2">{h.household.name} has no address yet. Add one with Edit household first.</p>
			) : (
				<>
					<div className="rounded-md bg-surface-2 px-4 py-3">
						<p className="text-xs text-text-3">Household address</p>
						<p className="mt-0.5 font-medium text-ink [overflow-wrap:anywhere]">{target}</p>
					</div>
					<ul className="flex flex-col" aria-label="Members">
						{h.members.map((m) => {
							const now = addressLine(m);
							const same = now === target;
							return (
								<li
									key={m.personId}
									className="flex items-start justify-between gap-3 border-t border-line py-2.5 first:border-t-0"
								>
									<div className="min-w-0">
										<p className="font-medium text-ink">{m.displayName}</p>
										<p className="text-sm text-text-3 [overflow-wrap:anywhere]">{now ?? "No address"}</p>
									</div>
									<span className="flex-none text-sm text-text-2">{same ? "Already the same" : "Changes"}</span>
								</li>
							);
						})}
					</ul>
					{changes.length === 0 ? <p className="text-sm text-text-2">Everyone already has this address.</p> : null}
				</>
			)}
		</RecordDialog>
	);
}

/** Take this person out of their household. Their own address stays; an emptied household can be deleted with it. */
export function LeaveHouseholdDialog({
	person,
	household,
	onClose,
	onSubmit,
	initial,
	problem,
	wait,
}: { person: PlantPerson; household: Household } & FormProps<LeaveValue>) {
	const first = person.displayName.split(" ")[0] ?? person.displayName;
	const last = household.members.length === 1 && household.members[0]?.personId === person.id;
	const [deleteEmpty, setDeleteEmpty] = useState(initial?.deleteEmpty ?? true);
	return (
		<RecordDialog
			icon={Logout01Icon}
			tone="magenta"
			title={`Take ${first} out of ${household.household.name}?`}
			action="Take out of household"
			onClose={onClose}
			problem={problem}
			wait={wait}
			onSubmit={() => {
				onSubmit({ deleteEmpty: last && deleteEmpty });
				return true;
			}}
		>
			<ul className="list-disc pl-5 text-sm text-text-2">
				<li>{first} keeps their own address.</li>
				<li>Their history keeps that they were in {household.household.name}.</li>
			</ul>
			{last ? (
				<Checkbox
					checked={deleteEmpty}
					onCheckedChange={(v) => setDeleteEmpty(v === true)}
					label={`Delete ${household.household.name} too`}
					description={`${first} is its last member, so it will be empty.`}
				/>
			) : null}
		</RecordDialog>
	);
}
