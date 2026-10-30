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
} from "@everyfield/ui/controls";
import { Avatar, Tag } from "@everyfield/ui/display";
import { startTransition, useOptimistic, useState, useTransition } from "react";
import type { z } from "zod";
import type { Outcome, SaveSpec } from "../../../components/save/model.ts";
import { NoticeInDialog, SaveNotice, useSaveIntent } from "../../../components/save/parts.tsx";
import type { Receipt } from "../boundary.ts";
import { throughStore, type PersonStore } from "../model.ts";
import { PersonLink, useStore } from "../parts.tsx";
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
type Kind = "start" | "join" | "edit" | "copy" | "leave";
/** The open household form and, after a refusal, the values it sent and why (`problem` is the refusal code). */
type Editing = { kind: Kind; value?: unknown; problem?: string };

/**
 * Household (REQ-PPL-009): who lives with this person and their role, the household address, and the deliberate
 * changes: start, join, change role, edit, copy the address to everyone, leave. Every change saves through the card's
 * save lane (components/save): one at a time, its own request key, one replay after a lost answer and Check again
 * while it stays unknown. Membership changes the Person, so they also run in the person store with the latest
 * revision. A change shows at once; a refusal rolls it back and opens the form again with the values and why, and a
 * conflict reads the household and the person again so the next try starts from what is saved.
 */
export function HouseholdCard({
	store,
	person,
	household,
	onHousehold,
	canEdit,
	onMembership,
	onConflict,
	onExpectPerson,
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
	/** Shows a change to this person at once while it saves (the copied address); it rolls back if refused. */
	onExpectPerson: (patch: Partial<PlantPerson>) => void;
}) {
	const [saving, start] = useTransition();
	// The last confirmed change, said in the card's status line instead of a toast that could cover the menu.
	const [notice, setNotice] = useState<string | null>(null);
	// The household as the screen expects it while a change saves; it falls back to the saved one if the change fails.
	const [shown, expect] = useOptimistic(household, (_h, next: HouseholdResult) => next);
	const first = person.displayName.split(" ")[0] ?? person.displayName;
	// Another change to this person is saving: the card waits, and Check again waits for it (C65, C68).
	useStore(store);
	const lane = useSaveIntent<Editing>({
		explain: (code) => householdProblem(code, first),
		busy: () => store.get().pending !== null,
	});
	const editing = lane.editing;
	const form = <T,>(kind: Kind) =>
		({
			onClose: lane.close,
			initial: editing?.kind === kind ? (editing.value as T | undefined) : undefined,
			problem: editing?.kind === kind ? lane.problem : undefined,
			wait: lane.wait,
		}) as const;
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

	/** Reads the household again after a conflict, so the card and the next try use what is saved. */
	async function refresh() {
		const r = await readHousehold(person.id).catch(() => null);
		if (r?.status === "ok") onHousehold(r.value);
	}
	const conflict = (code: string) => {
		if (code !== "conflict") return;
		void refresh();
		onConflict();
	};
	/** The page's person with the revision and address of their row in a household answer. */
	function fromMember(answer: HouseholdResult): PlantPerson | null {
		const row = answer.status === "available" ? answer.members.find((m) => m.personId === person.id) : undefined;
		return row ? { ...store.get().saved, ...addressOf(row), revision: row.revision } : null;
	}
	/** Shows the expected household at once, then saves through the lane; the transition rolls back a refusal. */
	function change<T>(next: HouseholdResult, spec: SaveSpec<Editing, T>, personPatch?: Partial<PlantPerson>) {
		setNotice(null);
		start(async () => {
			expect(next);
			if (personPatch) onExpectPerson(personPatch);
			await lane.save(spec);
		});
	}
	/**
	 * One membership write: it runs in the person store with the person's latest revision. A saved change updates the
	 * household, the person and Activity from the answer.
	 */
	function membership<A extends MembershipSaved>(
		slot: string,
		call: (key: string, revision: string) => Promise<Outcome<A>>,
		then?: () => void,
	): Pick<SaveSpec<Editing, A>, "send" | "through" | "ok" | "refused"> {
		const before = membershipOf(household, person.id);
		const revision = store.get().saved.revision;
		return {
			send: (key) => call(key, revision),
			// The answer's member row carries this person's new revision and address; after leaving, the saved Person.
			through: throughStore(store, slot, (v: MembershipSaved) => v.person ?? fromMember(v.household)),
			refused: conflict,
			ok: (value) => {
				const after = membershipOf(value.household, person.id);
				// After leaving, the answer is the household the person left; this person is now in none.
				onHousehold(after ? value.household : { status: "none" });
				// Copying the address keeps the membership; its record belongs to the household, not this person's Activity.
				if (before?.householdId !== after?.householdId || before?.role !== after?.role)
					onMembership(value.receipt, { from: before, to: after });
				then?.();
			},
		};
	}

	/** Starts a household with this person as head. `kind` is the form to reopen if it is refused, with `value` in it. */
	function startChange(v: StartValue, kind: Kind, value: unknown) {
		change(
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
			{
				what: v.name,
				done: "started",
				form: { kind, value },
				...membership("household-start", (key, rev) => startHousehold(key, rev, { ...v, headPersonId: person.id })),
			},
		);
	}

	function changeRole(role: HouseholdRole) {
		if (household?.status !== "available") return;
		change(
			{ ...household, members: household.members.map((m) => (m.personId === person.id ? { ...m, role } : m)) },
			{
				what: `${first}'s role`,
				done: "changed",
				...membership("household-role", (key, rev) => setHouseholdRole(key, rev, { personId: person.id, role })),
			},
		);
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
					canEdit && h && me && lane.wait === null ? (
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
								<MenuItem icon={Edit02Icon} onSelect={() => lane.open({ kind: "edit" })}>
									Edit household
								</MenuItem>
								<MenuItem icon={Copy01Icon} onSelect={() => lane.open({ kind: "copy" })}>
									Copy address to members
								</MenuItem>
								<MenuSeparator />
								<MenuItem icon={Logout01Icon} danger onSelect={() => lane.open({ kind: "leave" })}>
									Take {first} out
								</MenuItem>
							</MenuContent>
						</Menu>
					) : null
				}
			/>
			<p role="status" aria-live="polite" className="-mt-1 mb-2 text-xs text-text-3 empty:hidden">
				{saving ? "Saving…" : notice}
			</p>
			<SaveNotice {...lane.noticeProps} dialogOpen={editing !== null} />
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
							<Button size="sm" variant="secondary" onClick={() => lane.open({ kind: "join" })}>
								Add to a household
							</Button>
							<Button size="sm" variant="ghost" onClick={() => lane.open({ kind: "start" })}>
								Start a household
							</Button>
						</div>
					) : null}
				</div>
			)}

			<NoticeInDialog {...lane.noticeProps}>
				{editing?.kind === "start" ? (
					<StartHouseholdDialog
						person={person}
						{...form<StartValue>("start")}
						onSubmit={(v) => startChange(v, "start", v)}
					/>
				) : null}
				{editing?.kind === "join" ? (
					<JoinHouseholdDialog
						person={person}
						{...form<JoinValue>("join")}
						onSubmit={(v) =>
							v.mode === "create"
								? startChange(v, "join", v)
								: change(
										// The other members arrive with the answer; until then the card shows this person and "Saving…".
										{
											status: "available",
											household: { ...v.household, memberCount: v.household.memberCount + 1 },
											members: [{ ...me0, role: v.role, ...addressOf(person) }],
										},
										{
											what: first,
											done: `added to ${v.household.name}`,
											form: { kind: "join", value: v },
											...membership("household-join", (key, rev) =>
												joinHousehold(key, rev, { householdId: v.householdId, role: v.role, personId: person.id }),
											),
										},
									)
						}
					/>
				) : null}
				{editing?.kind === "leave" && h ? (
					<LeaveHouseholdDialog
						person={person}
						household={h}
						{...form<LeaveValue>("leave")}
						onSubmit={(v) =>
							change(
								{ status: "none" },
								{
									what: first,
									done: `taken out of ${h.household.name}`,
									form: { kind: "leave", value: v },
									...membership("household-leave", (key, rev) =>
										leaveHousehold(key, rev, {
											personId: person.id,
											deleteEmpty: v.deleteEmpty ? h.household.id : null,
										}),
									),
								},
							)
						}
					/>
				) : null}
				{editing?.kind === "edit" && h ? (
					<EditHouseholdDialog
						household={h}
						{...form<EditValue>("edit")}
						onSubmit={(patch) =>
							change(
								{ ...h, household: { ...h.household, ...patch } },
								{
									what: h.household.name,
									form: { kind: "edit", value: patch },
									send: (key) => updateHousehold(key, h.household.revision, { householdId: h.household.id, patch }),
									refused: (code) => {
										if (code === "conflict") void refresh();
									},
									ok: onHousehold,
								},
							)
						}
					/>
				) : null}
				{editing?.kind === "copy" && h ? (
					<CopyAddressDialog
						household={h}
						{...form<Household>("copy")}
						onSubmit={(preview) => {
							const members = preview.members.map((m) => ({ personId: m.personId, revision: m.revision }));
							const copied = addressOf(preview.household);
							change(
								{ ...preview, members: preview.members.map((m) => ({ ...m, ...copied })) },
								{
									what: "The address",
									done: "copied to every member",
									form: { kind: "copy" },
									...membership(
										"household-copy",
										(key) =>
											propagateAddress(key, preview.household.revision, {
												householdId: preview.household.id,
												members,
											}),
										() => startTransition(() => setNotice("Address copied to every member.")),
									),
								},
								// This person is one of the members, so Details shows the copied address at once too.
								copied,
							);
						}}
					/>
				) : null}
			</NoticeInDialog>
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
