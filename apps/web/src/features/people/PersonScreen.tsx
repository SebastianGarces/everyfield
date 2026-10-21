"use client";

import {
	ArrowTurnBackwardIcon,
	Delete02Icon,
	Edit02Icon,
	FileEditIcon,
	GitMergeIcon,
	MoreHorizontalIcon,
	UserCheck01Icon,
	UserIcon,
} from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import {
	Button,
	Card,
	CardHeader,
	CardHeading,
	CardTitle,
	IconButton,
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
	Breadcrumb,
	CalloutLabel,
	CalloutText,
	StatePanel,
} from "@everyfield/ui/controls";
import { KeyValue, KeyValueList, StageChip, StatusBadge } from "@everyfield/ui/display";
import Link from "next/link";
import { useOptimistic, useState } from "react";
import type { z } from "zod";
import { reloadPerson, type Receipt } from "./actions.ts";
import { ActivityCard, type Activities, type EntryFields, type Item } from "./ActivityCard.tsx";
import { CLASSIFICATION_LABEL, SOURCE_LABEL, STAGE_KEY, STAGE_LABEL, withEntry, type Outcome } from "./model.ts";
import { ClassificationDialog, EditProfileDialog, RestoreDialog, RetireDialog } from "./PersonDialogs.tsx";
import { LocalDay, usePersonStore, When } from "./parts.tsx";
import { StageDialog, type PersonDraft } from "./StageDialog.tsx";
import { HouseholdCard } from "./fields/HouseholdCard.tsx";
import type { HouseholdResult, PersonFields } from "./fields/model.ts";
import { PersonPhoto } from "./fields/PersonPhoto.tsx";
import { SkillsCard } from "./fields/SkillsCard.tsx";
import { TagsField } from "./fields/TagsField.tsx";
import { CorrectRecordDialog } from "./corrections/CorrectRecordDialog.tsx";
import { DuplicateHints } from "./corrections/DuplicateHints.tsx";
import { recordsIntent } from "./corrections/intent.ts";
import type { DuplicateHints as Hints } from "./corrections/server.ts";
import { UnmergeDialog } from "./corrections/UnmergeDialog.tsx";

type PlantPerson = z.infer<typeof people.plantPerson>;
type Open = "stage" | "profile" | "classify" | "retire" | "restore" | "correct" | { unmerge: string } | null;

/**
 * Person (REQ-PPL-002/003/004/006/008). The header says who and where in the pipeline; Owners and Admins change the
 * stage, edit the profile, record adult or child and retire or restore. Every change goes through one store, so only one
 * runs at a time and each uses the latest saved revision. A saved change shows from its answer: the store takes the
 * saved person and Activity adds the new entry, with no page reload. A refusal because this page was out of date
 * reads this person again, and nothing else.
 */
export function PersonScreen({
	person,
	activities,
	linked,
	isYou,
	survivor,
	accountId,
	canWrite,
	fields,
	photosEnabled,
	duplicates = null,
	followedMerge = false,
}: {
	person: PlantPerson;
	activities: Outcome<Activities>;
	/** The person has a live EveryField account link (never which account). */
	linked: boolean;
	/** The person is the viewer's own account person. */
	isYou: boolean;
	survivor: { id: string; name: string } | null;
	accountId: string;
	canWrite: boolean;
	/** Tags, skills, household and photo (WP-012). Null for a person they do not apply to. */
	fields: PersonFields | null;
	/** Private photo storage is configured, so photos can be added. */
	photosEnabled: boolean;
	/** Possible duplicates of this live person (WP-015). Null when they do not apply or could not be read. */
	duplicates?: Hints | null;
	/** The page opened from a link to a person who was merged into this one. */
	followedMerge?: boolean;
}) {
	const [store, state] = usePersonStore<PlantPerson, PersonDraft>(person);
	const [history, setHistory] = useState(activities);
	const show = (item: Item) => setHistory((h) => withEntry(h, item));
	const saved = (receipt: Receipt, fields: EntryFields) => {
		if (!receipt.changed) return;
		const at = receipt.at;
		show({
			id: receipt.id,
			occurredAt: at,
			recordedAt: at,
			actor: { kind: "current_account", accountId },
			...fields,
		} as Item);
	};
	const [household, setHousehold] = useState<HouseholdResult | null>(fields?.household ?? null);
	/** A saved tag, skill or photo change: Activity records it as a change to the person's details. */
	const changed = (receipt: Receipt) => saved(receipt, { kind: "activity", action: "updated" });
	const householdName = household?.status === "available" ? household.household.name : null;
	async function reload() {
		const r = await reloadPerson(person.id).catch(() => null);
		if (r?.status !== "ok") return;
		store.dispatch({ type: "server", person: r.value.person });
		if (r.value.activities) setHistory({ status: "ok", value: r.value.activities });
	}
	// The person as shown: the saved person, plus a change the screen expects while it saves (the household address
	// copied onto this person). It falls back to the saved person when that change is refused.
	const [p, expectPerson] = useOptimistic(state.saved, (saved, patch: Partial<PlantPerson>) => ({
		...saved,
		...patch,
	}));
	const [open, setOpen] = useState<Open>(null);
	const busy = state.pending !== null;
	const lifecycle = p.lifecycle;
	const live = lifecycle.state === "live";
	const toggle = (which: Exclude<Open, null>) => (next: boolean) => setOpen(next ? which : null);
	const close = () => setOpen(null);

	return (
		<>
			<header className="mb-[26px] flex items-end justify-between gap-6 max-app-md:flex-col max-app-md:items-start max-app-md:gap-4">
				<div className="min-w-0">
					<Breadcrumb items={[{ label: "People", href: "/people" }, { label: p.displayName }]} className="mb-4" />
					<div className="flex items-center gap-6 max-app-sm:gap-4">
						<PersonPhoto
							store={store}
							person={p}
							initial={fields?.photo ?? { status: "absent" }}
							canEdit={canWrite && live}
							enabled={photosEnabled}
							onSaved={changed}
						/>
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
								<h1 className="text-display-sm leading-[1.05] tracking-[-0.02em] text-ink text-balance max-app-sm:text-title-lg">
									{p.displayName}
								</h1>
								<StageChip stage={STAGE_KEY[p.stage]} className="h-[30px] text-[13px]">
									{STAGE_LABEL[p.stage]}
								</StageChip>
							</div>
							<p className="mt-2 flex flex-wrap items-center gap-2 text-[15px] text-text-2">
								<span>
									{householdName ? `${householdName} · ` : null}
									Added <When at={p.createdAt} />
									{p.source !== "other" ? ` · met through ${SOURCE_LABEL[p.source].toLowerCase()}` : null}
								</span>
								{isYou ? (
									<StatusBadge status="measured" size="sm">
										This is you
									</StatusBadge>
								) : linked ? (
									<StatusBadge status="measured" size="sm">
										Has an EveryField account
									</StatusBadge>
								) : null}
							</p>
						</div>
					</div>
				</div>
				<div className="flex max-w-full min-w-0 flex-wrap items-center gap-2.5">
					{canWrite && live ? (
						<>
							<Button variant="primary" icon={UserCheck01Icon} disabled={busy} onClick={() => setOpen("stage")}>
								Change stage
							</Button>
							<Menu>
								<MenuTrigger asChild>
									<IconButton icon={MoreHorizontalIcon} label="More actions" variant="soft" disabled={busy} />
								</MenuTrigger>
								<MenuContent align="end">
									<MenuItem icon={Edit02Icon} onSelect={() => setOpen("profile")}>
										Edit profile
									</MenuItem>
									<MenuItem icon={UserIcon} onSelect={() => setOpen("classify")}>
										{p.adultClassification === "unknown" ? "Record adult or child" : "Correct adult or child"}
									</MenuItem>
									<MenuItem icon={FileEditIcon} onSelect={() => setOpen("correct")} {...recordsIntent(p.id)}>
										Correct a record
									</MenuItem>
									<MenuSeparator />
									<MenuItem icon={Delete02Icon} danger onSelect={() => setOpen("retire")}>
										Retire person
									</MenuItem>
								</MenuContent>
							</Menu>
						</>
					) : null}
				</div>
			</header>

			{followedMerge && live ? (
				<Card variant="callout" tone="blue" className="mb-5">
					<CalloutLabel tone="blue" icon={GitMergeIcon}>
						Opened from a merged person
					</CalloutLabel>
					<CalloutText className="text-sm">
						The link you followed was for a person who was merged into {p.displayName}. Their history is in this
						Activity.
					</CalloutText>
				</Card>
			) : null}
			{lifecycle.state === "retired" ? (
				<Card className="mb-5">
					<StatePanel
						title={`${p.displayName} is retired`}
						headingLevel="h2"
						icon={ArrowTurnBackwardIcon}
						actions={
							canWrite ? (
								<Button variant="primary" disabled={busy} onClick={() => setOpen("restore")}>
									Restore person
								</Button>
							) : null
						}
					>
						Retired <When at={lifecycle.retiredAt} />. They are out of active lists and pickers. Their history stays
						here.
					</StatePanel>
				</Card>
			) : lifecycle.state === "merged" ? (
				<Card className="mb-5">
					<StatePanel title={`${p.displayName} was merged`} headingLevel="h2" icon={ArrowTurnBackwardIcon}>
						Merged <When at={lifecycle.retiredAt} /> into{" "}
						{survivor ? (
							<Link href={`/people/${survivor.id}`} className="font-medium text-ink underline">
								{survivor.name}
							</Link>
						) : (
							"another person"
						)}
						. A merge is undone only with a reviewed Unmerge, so this record cannot be restored here.
					</StatePanel>
				</Card>
			) : null}

			<div className="grid grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] items-start gap-5 max-app-lg:grid-cols-1">
				<div className="flex min-w-0 flex-col gap-5">
					<ActivityCard
						store={store}
						activities={history}
						onActivities={setHistory}
						onEntry={show}
						onConflict={reload}
						accountId={accountId}
						canWrite={canWrite}
						onUnmerge={canWrite ? (mergeId) => setOpen({ unmerge: mergeId }) : undefined}
					/>
				</div>
				<div className="flex min-w-0 flex-col gap-5 max-app-lg:order-first">
					<Card>
						<CardHeader className="mb-2">
							<CardHeading>
								<CardTitle size="sm">Details</CardTitle>
							</CardHeading>
							{canWrite && live ? (
								<IconButton
									icon={Edit02Icon}
									label="Edit profile"
									size="sm"
									disabled={busy}
									onClick={() => setOpen("profile")}
								/>
							) : null}
						</CardHeader>
						<KeyValueList>
							<KeyValue
								size="sm"
								k="Email"
								value={
									p.email ? (
										<a
											href={`mailto:${p.email}`}
											className="underline-offset-2 hover:underline [overflow-wrap:anywhere]"
										>
											{p.email}
										</a>
									) : null
								}
							/>
							<KeyValue
								size="sm"
								k="Phone"
								value={
									p.phone ? (
										<a href={`tel:${p.phone}`} className="underline-offset-2 hover:underline">
											{p.phone}
										</a>
									) : null
								}
							/>
							<KeyValue size="sm" k="Address" value={address(p)} />
							<KeyValue size="sm" k="Source" value={SOURCE_LABEL[p.source]} />
							{p.sourceDetails ? <KeyValue size="sm" k="Source details" value={p.sourceDetails} /> : null}
							<KeyValue size="sm" k="Birth date" value={p.birthDate ? <LocalDay day={p.birthDate} /> : null} />
						</KeyValueList>
						{fields ? (
							<TagsField
								personId={p.id}
								personName={p.displayName}
								initial={fields.tags}
								canEdit={canWrite && live}
								onSaved={changed}
							/>
						) : null}
					</Card>
					{duplicates && live ? <DuplicateHints personId={p.id} hints={duplicates} canReview={canWrite} /> : null}
					{fields ? (
						<>
							<HouseholdCard
								store={store}
								onExpectPerson={expectPerson}
								person={p}
								household={household}
								onHousehold={setHousehold}
								canEdit={canWrite && live}
								onMembership={(receipt, change) =>
									saved(receipt, { kind: "activity", action: "updated", household: change })
								}
								onConflict={reload}
							/>
							<SkillsCard
								personId={p.id}
								personName={p.displayName}
								initial={fields.skills}
								canEdit={canWrite && live}
								onSaved={changed}
							/>
						</>
					) : null}
					<Card>
						<CardHeader className="mb-2">
							<CardHeading>
								<CardTitle size="sm">Adult or child and commitment</CardTitle>
							</CardHeading>
						</CardHeader>
						<KeyValueList>
							<KeyValue
								size="sm"
								k="Adult or child"
								value={p.adultClassification === "unknown" ? null : CLASSIFICATION_LABEL[p.adultClassification]}
							/>
							<KeyValue
								size="sm"
								k="Commitment"
								value={
									p.commitment.state === "unknown" ? null : (
										<span className="flex items-center gap-2">
											<StatusBadge status={p.commitment.state === "active" ? "positive" : "unknown"} size="sm">
												{p.commitment.state === "active" ? "Committed" : "Withdrawn"}
											</StatusBadge>
											<span className="text-text-3">
												{p.commitment.kind === "core_group" ? "Core group" : "Launch team"} ·{" "}
												<LocalDay day={p.commitment.occurredOn} />
											</span>
										</span>
									)
								}
							/>
						</KeyValueList>
						<p className="mt-3 text-xs text-text-3">
							Recorded facts only. The stage alone never counts as a commitment or as adult.
						</p>
					</Card>
					{p.summaryNotes ? (
						<Card>
							<CardHeader className="mb-2">
								<CardHeading>
									<CardTitle size="sm">Summary</CardTitle>
								</CardHeading>
							</CardHeader>
							<p className="whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{p.summaryNotes}</p>
						</Card>
					) : null}
				</div>
			</div>

			{canWrite ? (
				<>
					{open === "stage" ? (
						<StageDialog
							open
							onOpenChange={toggle("stage")}
							store={store}
							onDone={(moved) =>
								saved(moved.receipt, { kind: "stage_changed", from: moved.from, to: moved.person.stage })
							}
							onConflict={reload}
						/>
					) : null}
					{open === "profile" ? (
						<EditProfileDialog
							open
							onOpenChange={toggle("profile")}
							store={store}
							onSaved={saved}
							onConflict={reload}
						/>
					) : null}
					{open === "classify" ? (
						<ClassificationDialog
							open
							onOpenChange={toggle("classify")}
							store={store}
							onSaved={saved}
							onConflict={reload}
						/>
					) : null}
					{open === "retire" ? (
						<RetireDialog open onOpenChange={toggle("retire")} store={store} onSaved={saved} onConflict={reload} />
					) : null}
					{open === "restore" ? (
						<RestoreDialog open onOpenChange={toggle("restore")} store={store} onSaved={saved} onConflict={reload} />
					) : null}
					{open === "correct" ? (
						<CorrectRecordDialog
							person={p}
							store={store}
							accountId={accountId}
							onClose={close}
							onCorrected={(receipt, type, recordId) =>
								saved(receipt, { kind: "activity", action: `${type}_corrected`, recordId } as EntryFields)
							}
						/>
					) : null}
					{open && typeof open === "object" ? (
						<UnmergeDialog
							mergeId={open.unmerge}
							store={store}
							onClose={close}
							onUnmerged={(done) => {
								if (done.activities) setHistory({ status: "ok", value: done.activities });
								else saved(done.receipt, { kind: "activity", action: "person_unmerged" });
							}}
						/>
					) : null}
				</>
			) : null}
		</>
	);
}

function address(p: PlantPerson) {
	const line = [p.street, [p.city, p.stateProvince].filter(Boolean).join(", "), p.postalCode, p.country]
		.filter((x) => x && x.trim())
		.join(" · ");
	return line || null;
}
