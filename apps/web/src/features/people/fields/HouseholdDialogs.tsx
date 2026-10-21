"use client";

import { Copy01Icon, Home01Icon, Logout01Icon } from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import {
	Button,
	Checkbox,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	Radio,
	RadioGroup,
	SearchInput,
	Select,
	Skeleton,
	Spinner,
} from "@everyfield/ui/controls";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { z } from "zod";
import type { Outcome } from "../model.ts";
import { problemText } from "../parts.tsx";
import { findHouseholds, readHousehold } from "./actions.ts";
import {
	addressLine,
	ROLE_LABEL,
	ROLES,
	type Household,
	type HouseholdResult,
	type HouseholdRole,
	type HouseholdSummary,
} from "./model.ts";

type PlantPerson = z.infer<typeof people.plantPerson>;
type Address = { street: string; city: string; stateProvince: string; postalCode: string; country: string };
/** What a household dialog sends; it answers with a refusal code to show, or nothing when saved. */
type Submit<T> = (value: T) => Promise<string | undefined>;

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
		case "conflict":
			return "This household or person changed while you were working. The latest details show now. Check them and try again.";
		case "invalid_subject":
			return `${first} is already in a household, or that household cannot take them. Take them out of their household first.`;
		default:
			return problemText(code);
	}
}

function Problem({ text }: { text: string | undefined }) {
	return (
		<div aria-live="assertive" className="empty:hidden">
			{text ? <p className="rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600">{text}</p> : null}
		</div>
	);
}

/** One dialog frame for the household forms: header, body, Cancel and the action, with a pending state. */
function FormDialog({
	icon,
	title,
	description,
	action,
	onClose,
	onSubmit,
	pending,
	problem,
	disabled,
	tone = "green",
	children,
}: {
	icon: typeof Home01Icon;
	title: string;
	description?: ReactNode;
	action: string;
	onClose: () => void;
	onSubmit: () => void;
	pending: boolean;
	problem?: string;
	disabled?: boolean;
	tone?: "green" | "blue" | "magenta";
	children: ReactNode;
}) {
	return (
		<Dialog open onOpenChange={(next) => !next && !pending && onClose()}>
			<DialogContent aria-busy={pending || undefined}>
				<form
					noValidate
					className="contents"
					onSubmit={(e) => {
						e.preventDefault();
						if (!pending && !disabled) onSubmit();
					}}
				>
					<DialogHeader icon={icon} tone={tone} title={title} description={description} />
					<DialogBody className="flex flex-col gap-4">
						{children}
						<Problem text={problem} />
					</DialogBody>
					<DialogFooter>
						<Button variant="secondary" type="button" onClick={onClose} disabled={pending}>
							Cancel
						</Button>
						<Button
							variant={tone === "magenta" ? "danger" : "primary"}
							type="submit"
							loading={pending}
							disabled={disabled}
						>
							{action}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Runs a dialog's submit: pending while it runs, the refusal text when refused; the caller closes it on success. */
function useSubmit<T>(submit: Submit<T>, onClose: () => void) {
	const [pending, setPending] = useState(false);
	const [problem, setProblem] = useState<string>();
	return {
		pending,
		problem,
		run: async (value: T) => {
			setPending(true);
			setProblem(undefined);
			const p = await submit(value);
			setPending(false);
			if (p) setProblem(p);
			else onClose();
		},
	};
}

function AddressFields({
	value,
	onChange,
	disabled,
}: {
	value: Address;
	onChange: (a: Address) => void;
	disabled: boolean;
}) {
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
						readOnly={disabled}
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
}: {
	person: PlantPerson;
	onClose: () => void;
	onSubmit: Submit<{ name: string } & { [K in keyof Address]: string | null }>;
}) {
	const [name, setName] = useState(defaultName(person));
	const [address, setAddress] = useState(addressDraft(person));
	const [touched, setTouched] = useState(false);
	const s = useSubmit(onSubmit, onClose);
	const missing = name.trim() === "";
	return (
		<FormDialog
			icon={Home01Icon}
			title="Start a household"
			description={`${person.displayName} will be its head. You can add the others next.`}
			action="Start household"
			onClose={onClose}
			pending={s.pending}
			problem={s.problem}
			onSubmit={() => {
				setTouched(true);
				if (!missing) void s.run({ name: name.trim(), ...addressValue(address) });
			}}
		>
			<Field label="Household name" error={touched && missing ? "Name the household, such as Santos household." : null}>
				<Input value={name} maxLength={255} readOnly={s.pending} autoFocus onChange={(e) => setName(e.target.value)} />
			</Field>
			<AddressFields value={address} onChange={setAddress} disabled={s.pending} />
		</FormDialog>
	);
}

/** Edit a household's name and address. Members keep their own addresses until someone copies it on purpose. */
export function EditHouseholdDialog({
	household,
	onClose,
	onSubmit,
}: {
	household: Household;
	onClose: () => void;
	onSubmit: Submit<{ name?: string } & { [K in keyof Address]: string | null }>;
}) {
	const h = household.household;
	const [name, setName] = useState(h.name);
	const [address, setAddress] = useState(addressDraft(h));
	const [touched, setTouched] = useState(false);
	const s = useSubmit(onSubmit, onClose);
	const missing = name.trim() === "";
	return (
		<FormDialog
			icon={Home01Icon}
			tone="blue"
			title={`Edit ${h.name}`}
			description="Members keep their own addresses. To give everyone this address, use Copy address to members."
			action="Save household"
			onClose={onClose}
			pending={s.pending}
			problem={s.problem}
			onSubmit={() => {
				setTouched(true);
				if (missing) return;
				void s.run({ ...(name.trim() !== h.name ? { name: name.trim() } : {}), ...addressValue(address) });
			}}
		>
			<Field label="Household name" error={touched && missing ? "Name the household." : null}>
				<Input value={name} maxLength={255} readOnly={s.pending} autoFocus onChange={(e) => setName(e.target.value)} />
			</Field>
			<AddressFields value={address} onChange={setAddress} disabled={s.pending} />
		</FormDialog>
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
}: {
	person: PlantPerson;
	onClose: () => void;
	onSubmit: Submit<{ householdId: string; role: HouseholdRole }>;
}) {
	const first = person.displayName.split(" ")[0] ?? person.displayName;
	const [search, setSearch] = useState("");
	const [found, setFound] = useState<Outcome<{ items: HouseholdSummary[]; total: number }> | null>(null);
	const [choice, setChoice] = useState<string>("");
	const [role, setRole] = useState<HouseholdRole | "">("");
	const [touched, setTouched] = useState(false);
	const s = useSubmit(onSubmit, onClose);
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
		<FormDialog
			icon={Home01Icon}
			title={`Add ${first} to a household`}
			description={
				person.street || person.city
					? `${first} keeps their own address.`
					: `${first} has no address yet, so they take the household's address.`
			}
			action="Add to household"
			onClose={onClose}
			pending={s.pending}
			problem={s.problem}
			onSubmit={() => {
				setTouched(true);
				if (choice && role) void s.run({ householdId: choice, role });
			}}
		>
			<SearchInput
				aria-label="Search households"
				placeholder="Search households"
				value={search}
				maxLength={255}
				autoFocus
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
					<RadioGroup aria-label="Household" value={choice} onValueChange={setChoice} className="gap-0 px-4">
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
			{touched && !choice ? <p className="text-xs font-medium text-magenta-600">Choose a household.</p> : null}
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
		</FormDialog>
	);
}

/**
 * Copy the household address to every member (REQ-PPL-009): a preview read fresh when the dialog opens shows each
 * member's address now and which ones change. Confirming overwrites exactly those reviewed members at once; if anyone
 * changed since the preview, nothing is written.
 */
export function CopyAddressDialog({
	personId,
	onClose,
	onSubmit,
}: {
	personId: string;
	onClose: () => void;
	onSubmit: Submit<Household>;
}) {
	const [preview, setPreview] = useState<Outcome<HouseholdResult> | null>(null);
	const s = useSubmit(onSubmit, onClose);
	useEffect(() => {
		let live = true;
		readHousehold(personId)
			.catch(() => ({ status: "lost" }) as const)
			.then((r) => live && setPreview(r));
		return () => {
			live = false;
		};
	}, [personId]);

	const h = preview?.status === "ok" && preview.value.status === "available" ? preview.value : null;
	const target = h ? addressLine(h.household) : null;
	const changes = h ? h.members.filter((m) => addressLine(m) !== target) : [];
	return (
		<FormDialog
			icon={Copy01Icon}
			tone="blue"
			title="Copy address to members"
			description="Every member below gets the household address. Check the list first."
			action={
				changes.length ? `Copy to ${changes.length} ${changes.length === 1 ? "person" : "people"}` : "Copy address"
			}
			onClose={onClose}
			pending={s.pending}
			problem={s.problem}
			disabled={!h || !target || changes.length === 0}
			onSubmit={() => h && void s.run(h)}
		>
			{preview === null ? (
				<div aria-busy="true" className="flex flex-col gap-2">
					<span className="sr-only" role="status">
						Loading the household
					</span>
					<Skeleton className="h-12 rounded-md" />
					<Skeleton className="h-12 rounded-md" />
				</div>
			) : !h ? (
				<Problem
					text={
						preview.status === "ok"
							? "This person is no longer in a household."
							: problemText(preview.status === "lost" ? "lost" : preview.code)
					}
				/>
			) : !target ? (
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
		</FormDialog>
	);
}

/** Take this person out of their household. Their own address stays; an emptied household can be deleted with it. */
export function LeaveHouseholdDialog({
	person,
	household,
	onClose,
	onSubmit,
}: {
	person: PlantPerson;
	household: Household;
	onClose: () => void;
	onSubmit: Submit<{ deleteEmpty: boolean }>;
}) {
	const first = person.displayName.split(" ")[0] ?? person.displayName;
	const last = household.members.length === 1 && household.members[0]?.personId === person.id;
	const [deleteEmpty, setDeleteEmpty] = useState(true);
	const s = useSubmit(onSubmit, onClose);
	return (
		<FormDialog
			icon={Logout01Icon}
			tone="magenta"
			title={`Take ${first} out of ${household.household.name}?`}
			action="Take out of household"
			onClose={onClose}
			pending={s.pending}
			problem={s.problem}
			onSubmit={() => void s.run({ deleteEmpty: last && deleteEmpty })}
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
		</FormDialog>
	);
}
