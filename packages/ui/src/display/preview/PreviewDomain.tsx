"use client";

import {
	Call02Icon,
	Calendar03Icon,
	Cancel01Icon,
	CheckmarkCircle02Icon,
	Megaphone01Icon,
	MusicNote01Icon,
	SentIcon,
	Task01Icon,
	UserGroupIcon,
	UserIcon,
	UserMultipleIcon,
	BookOpen01Icon,
	Activity01Icon,
	Tick02Icon,
	CrownIcon,
} from "@hugeicons/core-free-icons";
import { useState } from "react";
import { Button, Select } from "../../controls";
import {
	AreaTable,
	AttestationRow,
	AttestChip,
	BulkBar,
	CategoryCard,
	CheckinForm,
	CheckinHistory,
	CheckInRow,
	Composer,
	ComposerRow,
	DeliveryBar,
	DocCardGroup,
	DrillPath,
	EmailPreview,
	Journal,
	LensTile,
	MergeBlockers,
	MergeField,
	MergeReview,
	MilestoneGroup,
	MilestoneRow,
	MinistryCard,
	OutcomeField,
	OutcomeOptions,
	PersonCard,
	PhaseOptions,
	PipelineColumn,
	PrivateTag,
	RecipientChip,
	RoleSlot,
	StageStrip,
	StatusBadge,
	Tag,
	TaskRow,
	type Count,
	type MergeSide,
	type Wellbeing,
} from "..";
import { AREAS, CHECKIN_QUESTIONS, CHECKIN_WEEKS, DOCS, MERGE_FIELDS, PHASES } from "./fixtures";
import { Grid, Section, Specimen } from "./kit";

export function WorkSection({ index }: { index: number }) {
	const [done, setDone] = useState<Record<string, boolean>>({ agenda: true });
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const [adults, setAdults] = useState<Count>(null);
	const [guests, setGuests] = useState<Count>(0);
	const [drill, setDrill] = useState(2);
	const tasks = [
		{
			id: "call",
			title: "Call James Okafor",
			meta: [
				{ text: "Overdue 3 d", tone: "urgent" as const },
				{ text: "Follow-up", icon: UserIcon },
			],
		},
		{ id: "agenda", title: "Send agenda to hosts", meta: [{ text: "Oct 8" }] },
		{ id: "kit", title: "Build the welcome table kit", meta: [{ text: "Due Nov 15", tone: "soon" as const }] },
	];
	const steps = [
		{ label: "All people", count: 214 },
		{ label: "Core group", count: 34 },
		{ label: "No ministry", count: 11 },
	];
	return (
		<Section
			index={index}
			title="Domain: work and people"
			code="<MilestoneRow> <Journal> <OutcomeField> <TaskRow> <BulkBar> <PersonCard> <PipelineColumn> <MinistryCard> <RoleSlot> <LensTile> <DrillPath>"
			note="Display and interaction parts. The feature package owns the data, the rules (who may complete what) and drag and drop."
		>
			<Grid cols={2}>
				<Specimen title="Milestones" description="From the Launch Playbook · 9 milestones, 23 prep tasks">
					<MilestoneGroup label="Operations" count="2 of 3">
						<MilestoneRow
							state="done"
							title="Secure a launch venue"
							meta="Completed Sep 2 by Daniel · Lincoln Elementary gym"
							tasks={{ done: 3, total: 3 }}
							owner={{ name: "Daniel Reyes", tone: "green" }}
							href="#venue"
						/>
						<MilestoneRow
							state="active"
							progress={0.67}
							title="Buy sound, kids and welcome gear"
							meta="Due 12 weeks before launch · Dec 20"
							tasks={{ done: 2, total: 3 }}
							owner={{ name: "Tom Baker", tone: "violet" }}
							defaultOpen
						>
							<MilestoneRow.Tasks>
								<TaskRow
									title="Price a portable sound kit"
									titleText="Price a portable sound kit"
									done
									meta={[{ text: "Done Oct 1 · Tom" }]}
								/>
								<TaskRow
									title="Build the welcome table kit"
									titleText="Build the welcome table kit"
									done={false}
									onDoneChange={() => undefined}
									meta={[
										{ text: "Due Nov 15", tone: "soon" },
										{ text: "Ana Lee", icon: UserIcon },
									]}
								/>
							</MilestoneRow.Tasks>
							<MilestoneRow.Guard action={<Button size="sm">Complete milestone</Button>}>
								One linked task is still open. You can complete the milestone anyway; the task stays open.
							</MilestoneRow.Guard>
						</MilestoneRow>
					</MilestoneGroup>
					<MilestoneGroup label="Promotion" count="0 of 3">
						<MilestoneRow
							state="blocked"
							title="Hold three pre-launch services"
							meta="Waiting for a venue contract"
							tasks={{ done: 0, total: 3 }}
							owner={null}
						/>
						<MilestoneRow
							state="todo"
							title="Run the invitation campaign"
							meta="Starts 8 weeks before launch · Jan 17"
							tasks={{ done: 0, total: 2 }}
							owner={{ name: "Rosa Bennett", tone: "magenta" }}
							href="#campaign"
						/>
					</MilestoneGroup>
				</Specimen>
				<div className="flex flex-col gap-5">
					<Specimen title="Launch Sunday outcome" description="Empty is not recorded; 0 is a real result">
						<div className="flex flex-col gap-2">
							<OutcomeField label="Adults" value={null} />
							<OutcomeField label="Kids" value={0} />
							<OutcomeField label="Adults (edit)" value={adults} onChange={setAdults} />
							<OutcomeField label="First-time guests (edit)" value={guests} onChange={setGuests} />
						</div>
						<p className="mt-2 text-xs text-text-3" aria-live="polite">
							Recorded: adults {adults === null ? "not recorded" : adults}, first-time guests{" "}
							{guests === null ? "not recorded" : guests}
						</p>
					</Specimen>
					<Specimen title="Launch date history">
						<Journal
							label="Launch date history"
							items={[
								{
									id: "1",
									title: "Moved to Mar 14",
									meta: "Oct 1 · Daniel · “School gym booked for the 14th”",
									tone: "blue",
								},
								{
									id: "2",
									title: "Postponed from Feb 28",
									meta: "Sep 12 · Daniel · “Kids leader still open”",
									tone: "amber",
								},
								{ id: "3", title: "Scheduled for Feb 28", meta: "Jul 9 · Daniel", tone: "green" },
								{ id: "4", title: "Planning started", meta: "Mar 2 · Daniel" },
							]}
						/>
					</Specimen>
				</div>
				<Specimen title="Tasks" description="Select tasks to act on several at once">
					{tasks.map((t) => (
						<TaskRow
							key={t.id}
							title={t.title}
							titleText={t.title}
							done={done[t.id] ?? false}
							onDoneChange={(d) => setDone((s) => ({ ...s, [t.id]: d }))}
							selected={selected.has(t.id)}
							onSelectedChange={(on) =>
								setSelected((s) => {
									const n = new Set(s);
									if (on) n.add(t.id);
									else n.delete(t.id);
									return n;
								})
							}
							meta={t.meta}
							assignee={{ name: "Daniel Reyes", tone: "green" }}
						/>
					))}
					<BulkBar
						className="mt-3"
						count={selected.size}
						noun={["task", "tasks"]}
						actions={[
							{ label: "Complete", icon: Tick02Icon, onClick: () => setSelected(new Set()) },
							{ label: "Reschedule", icon: Calendar03Icon, onClick: () => undefined },
						]}
						onClear={() => setSelected(new Set())}
					/>
				</Specimen>
				<Specimen title="Ministry and roles">
					<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
						<MinistryCard
							name="Worship"
							icon={MusicNote01Icon}
							status="positive"
							statusLabel="Staffed"
							leader={{ name: "Tom Baker", tone: "violet" }}
							roles={{ filled: 7, total: 8 }}
							training="5 of 7 trained"
							href="#worship"
						/>
						<MinistryCard
							name="Kids"
							icon={UserGroupIcon}
							tone="amber"
							status="risk"
							statusLabel="Leader open"
							leader={null}
							roles={{ filled: 2, total: 6 }}
						/>
					</div>
					<div className="mt-4 flex flex-col gap-2">
						<RoleSlot
							role="Vocalist"
							person={{ name: "Maria Santos", tone: "blue" }}
							status={
								<StatusBadge status="positive" size="sm">
									Trained
								</StatusBadge>
							}
						/>
						<RoleSlot
							role="Sound tech"
							person={null}
							detail="Open role · 2 h a week"
							action={
								<Button variant="secondary" size="sm">
									Fill
								</Button>
							}
						/>
					</div>
				</Specimen>
			</Grid>
			<div className="mt-5 flex gap-4 overflow-x-auto pb-2">
				<PipelineColumn stage="interviewed" count={2}>
					<PersonCard
						name="Maria Santos"
						tone="blue"
						meta="Interviewed Sep 30"
						href="#maria"
						footer={
							<>
								<Tag tone="green">Worship</Tag>
								<StatusBadge status="positive" size="sm">
									Ready
								</StatusBadge>
							</>
						}
					/>
					<PersonCard
						name="David Kim"
						tone="amber"
						meta="Interviewed Sep 22"
						href="#david"
						selected
						footer={
							<>
								<span className="text-xs text-text-3">No ministry</span>
								<StatusBadge status="attention" size="sm">
									16 d
								</StatusBadge>
							</>
						}
					/>
				</PipelineColumn>
				<PipelineColumn stage="core" count={1} dropTarget>
					<PersonCard name="Ana Lee" tone="green" meta="Committed Oct 6" href="#ana" dragging />
				</PipelineColumn>
				<PipelineColumn stage="launch" count={0} />
			</div>
			<Grid cols={4} className="mt-5">
				<LensTile
					name="Vision casting"
					icon={Megaphone01Icon}
					state="positive"
					standing="Strong"
					note="Vision meetings every 12 days on average. The Playbook floor is 14."
				/>
				<LensTile
					name="Critical mass"
					icon={UserMultipleIcon}
					state="watch"
					standing="Watch"
					note="34 committed adults. Growth slowed for 21 days."
					onExpand={() => undefined}
				/>
				<LensTile
					name="Leader development"
					icon={CrownIcon}
					state="concern"
					standing="Concern"
					note="3 leader roles open, 107 days to launch."
					evidence="Attested"
				/>
				<LensTile
					name="Generosity"
					icon={Activity01Icon}
					state="unknown"
					standing="Not enough data"
					note="Nobody has answered the giving attestation yet."
					evidence="Unknown"
				/>
			</Grid>
			<DrillPath className="mt-5" steps={steps.slice(0, drill + 1)} onSelect={setDrill} onReset={() => setDrill(0)} />
			{drill < 2 ? (
				<Button variant="ghost" size="sm" className="mt-2" onClick={() => setDrill(2)}>
					Narrow again
				</Button>
			) : null}
		</Section>
	);
}

export function RecordsSection({ index }: { index: number }) {
	const [doc, setDoc] = useState<string | null>("response");
	const [phase, setPhase] = useState<number | null>(1);
	const [here, setHere] = useState<Record<string, boolean>>({ maria: true });
	const [outcome, setOutcome] = useState<string | null>("talked");
	const [choices, setChoices] = useState<Record<string, MergeSide>>({
		name: "keep",
		email: "remove",
		phone: "keep",
		household: "keep",
	});
	const [values, setValues] = useState<Record<string, Wellbeing | null>>({
		spirit: "steady",
		family: "steady",
		money: "strained",
		pace: null,
	});
	const [note, setNote] = useState("Taking Saturday fully off.");
	const [correcting, setCorrecting] = useState<string | null>(null);
	const [recipients, setRecipients] = useState(["Core group", "Maria Santos"]);
	const [inserted, setInserted] = useState<string | null>(null);
	return (
		<Section
			index={index}
			title="Domain: records, communication and network"
			code="<DeliveryBar> <Composer> <DocCard> <AttestationRow> <AttestChip> <CheckinForm> <CheckinHistory> <MergeReview> <PhaseOption> <CheckInRow> <OutcomeOption> <CategoryCard> <AreaTable>"
		>
			<Grid cols={2}>
				<Specimen title="Sent" description="Delivered counts only what the provider confirmed">
					<ul className="flex flex-col">
						{[
							{ t: "You're invited: Vision meeting #12", d: [31, 29, 4, 64], s: "48% opened · 4 bounced" },
							{ t: "Thank you for coming", d: [7, 2, 0, 9], s: "78% opened" },
							{
								t: "Core group: launch date update",
								d: [0, 0, 0, 34],
								s: "Email service rejected the batch",
								failed: true,
							},
						].map((r) => (
							<li
								key={r.t}
								className="flex items-center gap-4 border-t border-line py-3.5 first:border-t-0 max-app-sm:flex-wrap"
							>
								<span className="min-w-0 flex-1 font-medium text-ink">{r.t}</span>
								<span className="w-44 flex-none">
									<DeliveryBar
										opened={r.d[0]!}
										delivered={r.d[1]!}
										bounced={r.d[2]!}
										total={r.d[3]!}
										failed={r.failed}
									/>
									<span className={r.failed ? "mt-1 block text-sm text-magenta-600" : "mt-1 block text-sm text-text-3"}>
										{r.s}
									</span>
								</span>
								<StatusBadge status={r.failed ? "risk" : "positive"} size="sm">
									{r.failed ? "Failed" : "Sent"}
								</StatusBadge>
							</li>
						))}
					</ul>
				</Specimen>
				<Specimen title="New email" description="Email only. Merge fields fill in for each person.">
					<Composer>
						<ComposerRow label="To">
							{recipients.map((r) => (
								<RecipientChip
									key={r}
									label={r}
									count={r === "Core group" ? 34 : undefined}
									onRemove={() => setRecipients((rs) => rs.filter((x) => x !== r))}
								/>
							))}
							<Button variant="ghost" size="sm" onClick={() => setRecipients(["Core group", "Maria Santos"])}>
								Add
							</Button>
						</ComposerRow>
						<ComposerRow label="Template">
							<Select
								aria-label="Template"
								value="update"
								onValueChange={() => undefined}
								options={[
									{ value: "update", label: "Core group update" },
									{ value: "invite", label: "Vision meeting invitation" },
								]}
							/>
						</ComposerRow>
						<ComposerRow label="Subject">
							<span className="font-medium text-ink">
								Launch is set for <MergeField name="launch_date" />
							</span>
						</ComposerRow>
						<ComposerRow label="Insert" top>
							{["first_name", "church_name", "launch_date"].map((f) => (
								<MergeField key={f} name={f} onInsert={setInserted} />
							))}
							{inserted ? (
								<span className="sr-only" role="status">
									Inserted {inserted}
								</span>
							) : null}
						</ComposerRow>
					</Composer>
					<EmailPreview
						className="mt-3"
						recipient={{ name: "Maria Santos", email: "maria@example.org", tone: "blue" }}
						onNext={() => undefined}
					>
						<p className="font-semibold text-ink">Launch is set for March 14, 2027</p>
						<p className="mt-2">Hi Maria, thank you for being part of Harvest Point Church…</p>
					</EmailPreview>
					<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
						<span className="text-sm text-text-3">34 reachable · 1 without email</span>
						<div className="flex gap-2">
							<Button variant="secondary" size="sm">
								Send test
							</Button>
							<Button variant="primary" size="sm" icon={SentIcon}>
								Send to 34
							</Button>
						</div>
					</div>
				</Specimen>
			</Grid>
			<Specimen title="Documents" className="mt-5">
				<DocCardGroup label="Document templates" templates={DOCS} value={doc} onValueChange={setDoc} />
			</Specimen>
			<Specimen
				title="Prayer"
				description="Each answer is your dated statement"
				className="mt-5 px-0 py-1 max-app-sm:px-0"
			>
				<div className="px-7 pt-5 max-app-sm:px-5">
					<AttestChip label="Prayer leader assigned" answer="yes" when="Sep 2" onOpen={() => undefined} />
				</div>
				<div>
					<AttestationRow
						question="Prayer leader assigned"
						description="Someone owns the prayer covering for the plant."
						answer="yes"
						attestor={{ name: "Daniel Reyes", when: "Sep 2 · 39 days ago", detail: "Grace Kim" }}
						renewal={{ kind: "permanent" }}
						alsoOn={{ label: "Ministries · Prayer", href: "#ministries" }}
						onAction={() => undefined}
					/>
					<AttestationRow
						question="Corporate prayer rhythm established"
						description="Your core group has a regular rhythm of praying together."
						answer="yes"
						attestor={{ name: "Daniel Reyes", when: "Sep 7 · 34 days ago", detail: "Weekly, Thursday evenings" }}
						renewal={{ kind: "due" }}
						onAction={() => undefined}
					/>
					<AttestationRow
						question="Core group giving sacrificially"
						description="People in your core group are learning to give regularly."
						answer="none"
						renewal={{ kind: "unanswered" }}
						onAction={() => undefined}
					/>
					<AttestationRow
						question="Launch funding viable"
						description="Funds available now are enough to launch."
						answer="unsure"
						attestor={{ name: "Daniel Reyes", when: "Oct 1 · 10 days ago" }}
						renewal={{ kind: "current", daysLeft: 20 }}
						onAction={() => undefined}
					/>
				</div>
			</Specimen>
			<Grid cols={2} className="mt-5">
				<Specimen
					title={correcting ? `Week of ${correcting}` : "This week"}
					description="Pick the word that fits. There is no score."
					action={<PrivateTag />}
				>
					<CheckinForm
						questions={CHECKIN_QUESTIONS}
						values={values}
						onChange={(id, v) => setValues((s) => ({ ...s, [id]: v }))}
						note={note}
						onNoteChange={setNote}
						mode={correcting ? "correcting" : "current"}
						correctingWeek={correcting ?? undefined}
						onBackToCurrent={() => setCorrecting(null)}
						footer={
							<>
								<span className="text-sm text-text-3">You can change this week until Sunday.</span>
								<Button variant="primary">Save check-in</Button>
							</>
						}
					/>
				</Specimen>
				<Specimen title="Your last 12 weeks" description="Select the pencil to correct a past week">
					<CheckinHistory
						columns={["Spiritual", "Family", "Finances", "Pace"]}
						weeks={CHECKIN_WEEKS.map((w) => ({ ...w, onCorrect: () => setCorrecting(w.week) }))}
					/>
				</Specimen>
				<Specimen title="Possible duplicate" description="You choose which details to keep">
					<MergeReview
						keep={{ name: "James Okafor", meta: "Added Aug 20 · Following up", tone: "amber" }}
						remove={{ name: "Jim Okafor", meta: "Added Oct 2 · Prospect" }}
						fields={MERGE_FIELDS}
						choices={choices}
						onChoose={(id, side) => setChoices((c) => ({ ...c, [id]: side }))}
					/>
					<div className="mt-5 grid grid-cols-2 gap-5 max-app-sm:grid-cols-1">
						<MergeBlockers
							blockers={[]}
							rule="Merges stop if both people sit in the same ministry role or one has a signed commitment card."
						/>
						<MergeBlockers
							blockers={["Both people hold the Vocalist role in Worship."]}
							rule="Remove one of them from the role first, then merge."
						/>
					</div>
				</Specimen>
				<Specimen title="Where are you now?" description="Pick the phase you are in now">
					<PhaseOptions label="Current phase" phases={PHASES} value={phase} onValueChange={setPhase} />
				</Specimen>
				<Specimen title="Check-in at the door" description="Tap each person who arrives">
					<div className="flex flex-col gap-2">
						{[
							{ id: "maria", name: "Maria Santos", note: "+ Lucia Santos", tone: "blue" as const },
							{ id: "kim", name: "Kim Wu", note: "First-timer · invited by Tom", tone: "magenta" as const },
							{ id: "james", name: "James Okafor", note: "3rd visit", tone: "amber" as const },
						].map((p) => (
							<CheckInRow
								key={p.id}
								name={p.name}
								note={p.note}
								tone={p.tone}
								here={here[p.id] ?? false}
								onHereChange={(h) => setHere((s) => ({ ...s, [p.id]: h }))}
							/>
						))}
					</div>
				</Specimen>
				<Specimen title="How did the call go?">
					<OutcomeOptions
						label="Follow-up outcome"
						value={outcome}
						onValueChange={setOutcome}
						options={[
							{ id: "talked", title: "We talked", description: "Counts as contact", icon: CheckmarkCircle02Icon },
							{ id: "noanswer", title: "No answer", description: "Keeps the follow-up open", icon: Call02Icon },
							{ id: "closed", title: "No longer needed", description: "Closes without contact", icon: Cancel01Icon },
						]}
					/>
				</Specimen>
			</Grid>
			<Grid cols={3} className="mt-5">
				<CategoryCard title="People" icon={UserMultipleIcon} share="shared">
					<div className="flex items-end gap-3">
						<span className="num text-display-sm leading-none text-ink">46</span>
						<span className="pb-1 text-sm text-text-2">committed adults · +5 in 28 days</span>
					</div>
					<StageStrip
						className="mt-3"
						label="People by stage"
						segments={[
							{ label: "Prospect", count: 70, tone: "muted" },
							{ label: "Attendee", count: 31, tone: "blue" },
							{ label: "Following up", count: 12, tone: "amber" },
							{ label: "Interviewed", count: 9, tone: "violet" },
							{ label: "Core group", count: 46, tone: "green" },
							{ label: "Launch team", count: 18, tone: "teal" },
						]}
					/>
				</CategoryCard>
				<CategoryCard title="Wiki reading" icon={BookOpen01Icon} tone="teal" share="empty">
					Shared, but no one at Eastside Commons has finished a Playbook article in the last 28 days.
				</CategoryCard>
				<CategoryCard title="Activity updates" icon={Task01Icon} tone="ink" share="withheld">
					Priya has not shared activity updates with Austin Sending Network. This is a choice, not a zero.
				</CategoryCard>
			</Grid>
			<Specimen title="By area" description="Listed by size, not by score" className="mt-5">
				<AreaTable rows={AREAS} lensNames={["Launch readiness", "Momentum"]} />
			</Specimen>
		</Section>
	);
}
