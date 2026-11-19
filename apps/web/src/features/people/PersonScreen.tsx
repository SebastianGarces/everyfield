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
	Tab,
	Tabs,
	TabsList,
	TabsPanel,
} from "@everyfield/ui/controls";
import { KeyValue, KeyValueList, StageChip, StatusBadge } from "@everyfield/ui/display";
import Link from "next/link";
import { useOptimistic, useRef, useState, type ComponentProps } from "react";
import type { z } from "zod";
import { type Receipt } from "./actions.ts";
import { reloadPerson, loadPersonPage } from "./fetch.ts";
import { ActivityCard, type Activities, type EntryFields, type Item } from "./ActivityCard.tsx";
import { CLASSIFICATION_LABEL, SOURCE_LABEL, STAGE_KEY, STAGE_LABEL, withEntry } from "./model.ts";
import type { Outcome } from "../../components/save/model.ts";
import { ClassificationDialog, EditProfileDialog, RestoreDialog, RetireDialog } from "./PersonDialogs.tsx";
import { LocalDay, prefetchWarnings, usePersonStore, When } from "./parts.tsx";
import { StageDialog, type PersonDraft } from "./StageDialog.tsx";
import { HouseholdCard } from "./fields/HouseholdCard.tsx";
import type { HouseholdResult, PersonFields } from "./fields/model.ts";
import { PersonPhoto } from "./fields/PersonPhoto.tsx";
import { SkillsCard } from "./fields/SkillsCard.tsx";
import { MinistryRoles } from "./corrections/MinistryRoles.tsx";
import { TagsField } from "./fields/TagsField.tsx";
import type { PersonRecords } from "./assessments/model.ts";
import { RecordsSection, type CorrectedRecord } from "./assessments/RecordsSection.tsx";
import { EditRecordDialog } from "./corrections/EditRecordDialog.tsx";
import { DuplicateHints } from "./corrections/DuplicateHints.tsx";
import { recordsIntent, recordsRead, unmergeRead } from "./corrections/intent.ts";
import type { DuplicateHints as Hints, PersonPage } from "./corrections/server.ts";
import { UnmergeDialog } from "./corrections/UnmergeDialog.tsx";
import { type Unmerged } from "./corrections/actions.ts";
import { Problem } from "./corrections/parts.tsx";
import { PersonCommunication } from "../communication/PersonCommunication.tsx";
import { PersonFollowUps } from "../followups/PersonFollowUps.tsx";
import type { PersonFollowUps as FollowUpsData } from "../followups/server.ts";

type PlantPerson = z.infer<typeof people.plantPerson>;
type Open = "stage" | "profile" | "classify" | "retire" | "restore" | "correct" | { unmerge: string } | null;

export function PersonScreen({
	person,
	activities,
	linked,
	isYou,
	survivor,
	accountId,
	canWrite,
	fields: initialFields,
	records: initialRecords,
	followUps,
	photosEnabled,
	documentsEnabled,
	duplicates: initialDuplicates = null,
	followedMerge = false,
	ministries = null,
}: {
	person: PlantPerson;
	activities: Outcome<Activities>;
	linked: boolean;
	isYou: boolean;
	survivor: { id: string; name: string } | null;
	accountId: string;
	canWrite: boolean;
	fields: PersonFields | null;
	records: PersonRecords | null;
	followUps: FollowUpsData | null;
	photosEnabled: boolean;
	documentsEnabled: boolean;
	duplicates?: Hints | null;
	followedMerge?: boolean;
	ministries?: ComponentProps<typeof MinistryRoles>["initial"] | null;
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
	const [parts, setParts] = useState({
		fields: initialFields,
		records: initialRecords,
		duplicates: initialDuplicates,
		generation: 0,
		household: initialFields?.household ?? null,
		corrected: [] as CorrectedRecord[],
	});
	const { fields, records, duplicates, generation, household, corrected } = parts;
	const setHousehold = (next: HouseholdResult | null) => setParts((old) => ({ ...old, household: next }));
	const changed = (receipt: Receipt) => saved(receipt, { kind: "activity", action: "updated" });
	const householdName = household?.status === "available" ? household.household.name : null;
	async function reload() {
		const r = await reloadPerson(person.id).catch(() => null);
		if (r?.status !== "ok") return;
		store.getState().actions.server(r.value.person);
		if (r.value.activities) setHistory({ status: "ok", value: r.value.activities });
	}
	const [p, expectPerson] = useOptimistic(state.saved, (saved, patch: Partial<PlantPerson>) => ({
		...saved,
		...patch,
	}));
	const [open, setOpen] = useState<Open>(null);
	const [stale, setStale] = useState(false);
	const fresh = useRef<{ receipt: Receipt | null; page: PersonPage | null } | null>(null);
	async function readAfterUnmerge(done: Unmerged | null): Promise<boolean> {
		let page = done ? done.page : null;
		if (!done) {
			const r = await loadPersonPage(person.id).catch(() => ({ status: "lost" }) as const);
			page = r.status === "ok" ? r.value : null;
		}
		fresh.current = { receipt: done?.receipt ?? fresh.current?.receipt ?? null, page };
		return page !== null;
	}
	function closeUnmerge() {
		const got = fresh.current;
		fresh.current = null;
		setOpen(null);
		if (!got) return;
		if (got.receipt) saved(got.receipt, { kind: "activity", action: "person_unmerged" });
		const page = got.page;
		if (!page) return setStale(true);
		store.getState().actions.server(page.person);
		if (page.activities) setHistory({ status: "ok", value: page.activities });
		setParts((old) => ({
			fields: page.fields,
			records: page.records,
			duplicates: page.duplicates,
			generation: old.generation + 1,
			household: page.fields?.household ?? null,
			corrected: [],
		}));
		setStale(false);
	}

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
							key={generation}
							store={store}
							person={p}
							initial={fields?.photo ?? { status: "absent" }}
							canEdit={canWrite && live}
							enabled={photosEnabled}
							onSaved={changed}
							onConflict={reload}
						/>
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
								<h1 className="text-display-sm leading-[1.05] tracking-[-0.02em] text-ink text-balance max-app-sm:text-title-lg">
									{p.displayName}
								</h1>
								<StageChip stage={STAGE_KEY[p.stage]} className="h-[30px] text-[13px] leading-(--text-xs--line-height)">
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
										Has an Everyfield account
									</StatusBadge>
								) : null}
							</p>
						</div>
					</div>
				</div>
				<div className="flex max-w-full min-w-0 flex-wrap items-center gap-2.5">
					{canWrite && live ? (
						<>
							<Button
								variant="primary"
								icon={UserCheck01Icon}
								disabled={busy}
								onClick={() => {
									prefetchWarnings(p.id);
									setOpen("stage");
								}}
							>
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
									<MenuItem
										icon={FileEditIcon}
										onSelect={() => {
											recordsRead.prefetch(p.id);
											setOpen("correct");
										}}
										{...recordsIntent(p.id)}
									>
										Edit a record
									</MenuItem>
									{p.birthDate ? null : (
										<MenuItem icon={UserIcon} onSelect={() => setOpen("classify")}>
											{p.adultClassification === "unknown" ? "Record adult or child" : "Correct adult or child"}
										</MenuItem>
									)}
									<MenuSeparator />
									<MenuItem
										icon={Delete02Icon}
										danger
										onSelect={() => {
											prefetchWarnings(p.id);
											setOpen("retire");
										}}
									>
										Retire person
									</MenuItem>
								</MenuContent>
							</Menu>
						</>
					) : null}
				</div>
			</header>

			{stale ? (
				<div className="mb-5">
					<Problem>
						The Unmerge was saved, but this page did not read the moved records again.{" "}
						<button
							type="button"
							className="font-medium underline underline-offset-2"
							onClick={() => location.reload()}
						>
							Reload the page
						</button>{" "}
						to see where they are now.
					</Problem>
				</div>
			) : null}
			{followedMerge && live ? (
				<Card variant="callout" tone="blue" className="mb-5">
					<CalloutLabel tone="blue" icon={GitMergeIcon}>
						Opened from a merged person
					</CalloutLabel>
					<CalloutText className="leading-(--text-sm--line-height)">
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

			<Tabs defaultValue="profile">
				<TabsList aria-label="Person">
					<Tab value="profile">Profile</Tab>
					<Tab value="communication">Communication</Tab>
				</TabsList>
				<TabsPanel value="profile">
					<div className="grid grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] items-start gap-5 max-app-lg:grid-cols-1">
						<div className="flex min-w-0 flex-col gap-5">
							{records ? (
								<RecordsSection
									key={generation}
									records={records}
									documentsEnabled={documentsEnabled}
									personId={p.id}
									personName={p.displayName}
									stage={p.stage}
									store={store}
									expectPerson={expectPerson}
									canEdit={canWrite && live}
									accountId={accountId}
									onSaved={saved}
									onConflict={reload}
									corrected={corrected}
								/>
							) : null}
							{followUps ? (
								<PersonFollowUps
									initial={followUps}
									person={{ id: p.id, label: p.displayName }}
									accountId={accountId}
									admin={canWrite}
									live={live}
								/>
							) : null}
							<ActivityCard
								store={store}
								activities={history}
								onActivities={setHistory}
								onEntry={show}
								onConflict={reload}
								accountId={accountId}
								canWrite={canWrite}
								onUnmerge={
									canWrite
										? (mergeId) => {
												unmergeRead.prefetch(mergeId);
												setOpen({ unmerge: mergeId });
											}
										: undefined
								}
							/>
						</div>
						<div className="flex min-w-0 flex-col gap-5 max-app-lg:order-first">
							<Card>
								<CardHeader>
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
										key={generation}
										personId={p.id}
										personName={p.displayName}
										initial={fields.tags}
										canEdit={canWrite && live}
										onSaved={changed}
									/>
								) : null}
							</Card>
							{duplicates && live ? (
								<DuplicateHints key={generation} personId={p.id} hints={duplicates} canReview={canWrite} />
							) : null}
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
										key={generation}
										personId={p.id}
										personName={p.displayName}
										initial={fields.skills}
										canEdit={canWrite && live}
										onSaved={changed}
									/>
								</>
							) : null}
							{ministries ? (
								<MinistryRoles key={`ministries-${generation}`} initial={ministries} canCorrect={canWrite} />
							) : null}
							<Card>
								<CardHeader>
									<CardHeading>
										<CardTitle size="sm">{records ? "Adult or child" : "Adult or child and commitment"}</CardTitle>
									</CardHeading>
								</CardHeader>
								<KeyValueList>
									<KeyValue
										size="sm"
										k="Adult or child"
										value={
											p.adultClassification === "unknown" ? null : p.adultClassificationSource === "birth_date" ? (
												<span className="flex items-center gap-2">
													{CLASSIFICATION_LABEL[p.adultClassification]}
													<span className="text-text-3">From birth date</span>
												</span>
											) : (
												CLASSIFICATION_LABEL[p.adultClassification]
											)
										}
									/>
									{records ? null : (
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
									)}
								</KeyValueList>
								<p className="mt-3 text-xs text-text-3">
									Recorded facts only. A birth date sets adult or child. The stage alone never counts as a commitment or
									as adult.
								</p>
							</Card>
							{p.summaryNotes ? (
								<Card>
									<CardHeader>
										<CardHeading>
											<CardTitle size="sm">Summary</CardTitle>
										</CardHeading>
									</CardHeader>
									<p className="whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{p.summaryNotes}</p>
								</Card>
							) : null}
						</div>
					</div>
				</TabsPanel>
				<TabsPanel value="communication">
					<PersonCommunication personId={p.id} canWrite={canWrite} />
				</TabsPanel>
			</Tabs>

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
						<EditRecordDialog
							person={p}
							store={store}
							accountId={accountId}
							onClose={close}
							onEdited={(receipt, next) => {
								setParts((old) => ({
									...old,
									corrected: [...old.corrected.filter((c) => c.record.id !== next.record.id), next],
								}));
								if (receipt)
									saved(receipt, {
										kind: "activity",
										action: `${next.type}_corrected`,
										recordId: next.record.id,
									} as EntryFields);
							}}
						/>
					) : null}
					{open && typeof open === "object" ? (
						<UnmergeDialog mergeId={open.unmerge} store={store} onClose={closeUnmerge} onUnmerged={readAfterUnmerge} />
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
