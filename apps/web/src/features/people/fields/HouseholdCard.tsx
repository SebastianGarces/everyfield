"use client";

import { Copy01Icon, Edit02Icon, Logout01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	IconButton,
	Menu,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuTrigger,
	useToast,
} from "@everyfield/ui/controls";
import { Avatar, Tag } from "@everyfield/ui/display";
import { useOptimistic, useState, useTransition } from "react";
import type { z } from "zod";
import type { Receipt } from "../boundary.ts";
import { runSave, type Outcome, type PersonStore } from "../model.ts";
import { fresh, PersonLink } from "../parts.tsx";
import type { PersonDraft } from "../StageDialog.tsx";
import {
	joinHousehold,
	leaveHousehold,
	propagateAddress,
	readHousehold,
	setHouseholdRole,
	startHousehold,
	updateHousehold,
	type MembershipSaved,
} from "./actions.ts";
import {
	CopyAddressDialog,
	EditHouseholdDialog,
	householdProblem,
	JoinHouseholdDialog,
	LeaveHouseholdDialog,
	StartHouseholdDialog,
	type EditValue,
	type JoinValue,
	type LeaveValue,
	type StartValue,
} from "./HouseholdDialogs.tsx";
import {
	addressLine,
	membershipOf,
	ROLE_LABEL,
	ROLES,
	type Household,
	type HouseholdResult,
	type HouseholdRole,
	type Membership,
} from "./model.ts";

type PlantPerson = z.infer<typeof people.plantPerson>;
type Store = PersonStore<PlantPerson, PersonDraft>;
type Open = "start" | "join" | "edit" | "copy" | "leave" | null;
const codeOf = (r: Outcome<unknown> | null) =>
	!r ? "busy" : r.status === "refused" ? r.code : r.status === "lost" ? "lost" : null;

/**
 * Household (REQ-PPL-009): who lives with this person and their role, the household address, and the deliberate
 * changes: start, join, change role, edit, copy the address to everyone, leave. Membership changes the Person, so they
 * go through the person store one at a time with the latest revision; a role change shows at once and rolls back with
 * a message. A refused change reads the household again so the next try starts from what is saved.
 */
export function HouseholdCard({
	store,
	person,
	household,
	onHousehold,
	canEdit,
	onMembership,
	onConflict,
}: {
	store: Store;
	person: PlantPerson;
	/** Null when the household did not load. */
	household: HouseholdResult | null;
	onHousehold: (h: HouseholdResult) => void;
	canEdit: boolean;
	/** A saved membership change, with the membership before and after, for Activity. */
	onMembership: (receipt: Receipt, change: { from: Membership | null; to: Membership | null }) => void;
	/** The person changed elsewhere: read the person again. */
	onConflict: () => void;
}) {
	const toast = useToast();
	const [open, setOpen] = useState<Open>(null);
	const [saving, start] = useTransition();
	// The household as the screen expects it while a change saves; it falls back to the saved one if the change fails.
	const [shown, expect] = useOptimistic(household, (_h, next: HouseholdResult) => next);
	// A refused form change: the dialog opens again with what was entered and why it did not save.
	const [retry, setRetry] = useState<{ kind: Exclude<Open, null>; value: unknown; problem: string } | null>(null);
	const first = person.displayName.split(" ")[0] ?? person.displayName;
	const close = () => {
		setOpen(null);
		setRetry(null);
	};
	const retryOf = <T,>(kind: Exclude<Open, null>) =>
		retry?.kind === kind ? { value: retry.value as T, problem: retry.problem } : undefined;
	/** Closes the dialog, shows the expected household at once, then confirms or rolls back and reopens the form. */
	function optimistic(
		kind: Exclude<Open, null>,
		value: unknown,
		next: HouseholdResult,
		work: () => Promise<string | undefined>,
	) {
		close();
		start(async () => {
			expect(next);
			const problem = await work();
			if (problem) {
				setRetry({ kind, value, problem });
				setOpen(kind);
			}
		});
	}
	const me0 = { personId: person.id, displayName: person.displayName, revision: person.revision };
	type AddressLike = { [K in "street" | "city" | "stateProvince" | "postalCode" | "country"]?: string | null };
	const addressOf = (a: AddressLike) => ({
		street: a.street ?? null,
		city: a.city ?? null,
		stateProvince: a.stateProvince ?? null,
		postalCode: a.postalCode ?? null,
		country: a.country ?? null,
	});
	const placeholder = { id: person.id as string, revision: person.revision } as Household["household"];

	/** Reads the household again after a refusal, so the card and the next try use what is saved. */
	async function refresh() {
		const r = await readHousehold(person.id).catch(() => null);
		if (r?.status === "ok") onHousehold(r.value);
	}
	/**
	 * One membership write through the person store. Gives the refusal text to show, or nothing when saved; a saved
	 * change updates the household, the person and Activity from the answer.
	 */
	async function membership(
		slot: string,
		payload: unknown,
		call: (key: string, revision: string) => Promise<Outcome<MembershipSaved>>,
	): Promise<string | undefined> {
		const before = membershipOf(household, person.id);
		const revision = store.get().saved.revision;
		const r = await runSave(store, slot, payload, (key) => call(key, revision), { fresh, toPerson: (v) => v.person });
		if (r?.status === "ok") {
			const after = membershipOf(r.value.household, person.id);
			// After leaving, the answer is the household the person left; this person is now in none.
			onHousehold(after ? r.value.household : { status: "none" });
			// Copying the address keeps the membership; its record belongs to the household, not this person's Activity.
			if (before?.householdId !== after?.householdId || before?.role !== after?.role)
				onMembership(r.value.receipt, { from: before, to: after });
			return undefined;
		}
		const code = codeOf(r) ?? "lost";
		if (code === "conflict") {
			void refresh();
			onConflict();
		}
		return code === "busy"
			? "Another change to this person is still saving. Try again in a moment."
			: householdProblem(code, first);
	}

	function changeRole(role: HouseholdRole) {
		start(async () => {
			if (household?.status === "available")
				expect({
					...household,
					members: household.members.map((m) => (m.personId === person.id ? { ...m, role } : m)),
				});
			const problem = await membership("household-role", { role }, (key, rev) =>
				setHouseholdRole(key, rev, { personId: person.id, role }),
			);
			if (problem) toast({ tone: "error", message: `The role was not changed. ${problem}` });
		});
	}

	if (household === null)
		return (
			<Card>
				<Header />
				<p className="text-sm text-text-3">The household did not load. Reload the page to see it.</p>
			</Card>
		);

	const h = shown?.status === "available" ? shown : null;
	const me = h?.members.find((m) => m.personId === person.id);

	return (
		<Card>
			<Header
				description={h ? h.household.name : undefined}
				action={
					canEdit && h && me && !saving ? (
						<Menu>
							<MenuTrigger asChild>
								<IconButton icon={MoreHorizontalIcon} label="Household actions" size="sm" />
							</MenuTrigger>
							<MenuContent align="end">
								<MenuLabel>{first}&apos;s role</MenuLabel>
								<MenuRadioGroup value={me.role} onValueChange={(r) => changeRole(r as HouseholdRole)}>
									{ROLES.map((r) => (
										<MenuRadioItem key={r} value={r}>
											{ROLE_LABEL[r]}
										</MenuRadioItem>
									))}
								</MenuRadioGroup>
								<MenuSeparator />
								<MenuItem icon={Edit02Icon} onSelect={() => setOpen("edit")}>
									Edit household
								</MenuItem>
								<MenuItem icon={Copy01Icon} onSelect={() => setOpen("copy")}>
									Copy address to members
								</MenuItem>
								<MenuSeparator />
								<MenuItem icon={Logout01Icon} danger onSelect={() => setOpen("leave")}>
									Take {first} out
								</MenuItem>
							</MenuContent>
						</Menu>
					) : null
				}
			/>
			<p role="status" aria-live="polite" className="-mt-1 mb-2 text-xs text-text-3 empty:hidden">
				{saving ? "Saving…" : null}
			</p>
			{h ? (
				<>
					{addressLine(h.household) ? (
						<p className="mb-2 text-sm text-text-2 [overflow-wrap:anywhere]">{addressLine(h.household)}</p>
					) : null}
					<ul aria-label={`Members of ${h.household.name}`} className="flex flex-col">
						{h.members.map((m) => (
							<li
								key={m.personId}
								className="flex min-h-11 items-center gap-3 border-t border-line py-1.5 first:border-t-0"
							>
								<Avatar name={m.displayName} size="sm" decorative />
								<span className="min-w-0 flex-1 truncate">
									{m.personId === person.id ? (
										<span className="font-medium text-ink">
											{m.displayName} <span className="font-normal text-text-3">(this person)</span>
										</span>
									) : (
										<PersonLink
											href={`/people/${m.personId}`}
											className="font-medium text-ink underline-offset-2 hover:underline"
										>
											{m.displayName}
										</PersonLink>
									)}
								</span>
								<Tag className="h-[22px] px-2 text-xs">{ROLE_LABEL[m.role]}</Tag>
							</li>
						))}
					</ul>
				</>
			) : (
				<div className="flex flex-col items-start gap-3">
					<p className="text-sm text-text-3">{first} is not in a household.</p>
					{canEdit ? (
						<div className="flex flex-wrap gap-2">
							<Button size="sm" variant="secondary" onClick={() => setOpen("join")}>
								Add to a household
							</Button>
							<Button size="sm" variant="ghost" onClick={() => setOpen("start")}>
								Start a household
							</Button>
						</div>
					) : null}
				</div>
			)}

			{open === "start" ? (
				<StartHouseholdDialog
					person={person}
					onClose={close}
					retry={retryOf<StartValue>("start")}
					onSubmit={(v) =>
						optimistic(
							"start",
							v,
							{
								status: "available",
								// A stand-in until the answer: the card hides household actions while it saves, so this ID is never sent.
								household: {
									id: placeholder.id,
									name: v.name,
									...addressOf(v),
									revision: placeholder.revision,
									memberCount: 1,
								},
								members: [{ ...me0, role: "head", ...addressOf(v) }],
							},
							() =>
								membership("household-start", v, (key, rev) =>
									startHousehold(key, rev, { ...v, headPersonId: person.id }),
								),
						)
					}
				/>
			) : null}
			{open === "join" ? (
				<JoinHouseholdDialog
					person={person}
					onClose={close}
					retry={retryOf<JoinValue>("join")}
					onSubmit={(v) =>
						optimistic(
							"join",
							v,
							// The other members arrive with the answer; until then the card shows this person and "Saving…".
							{
								status: "available",
								household: { ...v.household, memberCount: v.household.memberCount + 1 },
								members: [{ ...me0, role: v.role, ...addressOf(person) }],
							},
							() =>
								membership("household-join", v, (key, rev) =>
									joinHousehold(key, rev, { householdId: v.householdId, role: v.role, personId: person.id }),
								),
						)
					}
				/>
			) : null}
			{open === "leave" && h ? (
				<LeaveHouseholdDialog
					person={person}
					household={h}
					onClose={close}
					retry={retryOf<LeaveValue>("leave")}
					onSubmit={(v) =>
						optimistic("leave", v, { status: "none" }, () =>
							membership("household-leave", v, (key, rev) =>
								leaveHousehold(key, rev, { personId: person.id, deleteEmpty: v.deleteEmpty ? h.household.id : null }),
							),
						)
					}
				/>
			) : null}
			{open === "edit" && h ? (
				<EditHouseholdDialog
					household={h}
					onClose={close}
					retry={retryOf<EditValue>("edit")}
					onSubmit={(patch) =>
						optimistic("edit", patch, { ...h, household: { ...h.household, ...patch } }, async () => {
							const r = await updateHousehold(fresh(), h.household.revision, {
								householdId: h.household.id,
								patch,
							}).catch(() => ({ status: "lost" }) as const);
							if (r.status === "ok") return void onHousehold(r.value);
							if (codeOf(r) === "conflict") void refresh();
							return householdProblem(codeOf(r) ?? "lost", first);
						})
					}
				/>
			) : null}
			{open === "copy" && h ? (
				<CopyAddressDialog
					personId={person.id}
					onClose={close}
					retry={retryOf<unknown>("copy")}
					onSubmit={(preview) => {
						const members = preview.members.map((m) => ({ personId: m.personId, revision: m.revision }));
						const copied = addressOf(preview.household);
						optimistic(
							"copy",
							preview,
							{ ...preview, members: preview.members.map((m) => ({ ...m, ...copied })) },
							async () => {
								const problem = await membership("household-copy", members, (key) =>
									propagateAddress(
										key,
										preview.household.revision,
										{ householdId: preview.household.id, members },
										person.id,
									),
								);
								if (!problem) toast({ tone: "success", message: `Copied the address of ${preview.household.name}.` });
								return problem;
							},
						);
					}}
				/>
			) : null}
		</Card>
	);
}

function Header({ description, action }: { description?: string; action?: React.ReactNode }) {
	return (
		<CardHeader className="mb-2">
			<CardHeading>
				<CardTitle size="sm">Household</CardTitle>
				{description ? <CardDescription>{description}</CardDescription> : null}
			</CardHeading>
			{action}
		</CardHeader>
	);
}
