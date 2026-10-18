"use client";

import {
	Alert02Icon,
	ArrowRight01Icon,
	Calendar03Icon,
	CheckmarkCircle02Icon,
	MusicNote01Icon,
	Tick02Icon,
	UserIcon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { useMemo, useState } from "react";
import { SegmentedControl } from "../../controls";
import { Icon } from "../../foundations";
import {
	Avatar,
	AvatarGroup,
	BulkBar,
	CoverageBar,
	DataTable,
	DeltaChip,
	KeyValue,
	KeyValueList,
	Legend,
	List,
	ListRow,
	Pagination,
	Progress,
	Ring,
	Stat,
	StageChip,
	StatStrip,
	StatusBadge,
	STAGES,
	Tag,
	TargetBar,
	ZeroMetric,
	type Loadable,
} from "..";
import { PEOPLE, type Person } from "./fixtures";
import { Grid, Section, Specimen } from "./kit";

export function BadgesSection({ index }: { index: number }) {
	return (
		<Section
			index={index}
			title="Badges, chips and avatars"
			code="<StatusBadge status fill> <DeltaChip dir> <Tag> <StageChip stage> <Avatar> <AvatarGroup>"
			note="The dot, arrow or tint repeats what the word already says, so no state depends on color alone."
		>
			<Grid cols={2}>
				<Specimen>
					<div className="flex flex-col gap-4">
						<div className="flex flex-wrap gap-2">
							<StatusBadge status="positive">On track</StatusBadge>
							<StatusBadge status="measured">Measured</StatusBadge>
							<StatusBadge status="attention">Waiting</StatusBadge>
							<StatusBadge status="risk">Overdue</StatusBadge>
							<StatusBadge status="unknown">Unknown</StatusBadge>
						</div>
						<div className="flex flex-wrap gap-2">
							<StatusBadge fill="soft" status="positive">
								Committed
							</StatusBadge>
							<StatusBadge fill="soft" status="measured">
								Attested
							</StatusBadge>
							<StatusBadge fill="soft" status="attention">
								Draft
							</StatusBadge>
							<StatusBadge fill="soft" status="risk">
								Gap
							</StatusBadge>
							<StatusBadge plain size="sm">
								12
							</StatusBadge>
						</div>
						<div className="flex flex-wrap gap-2">
							<DeltaChip dir="up">9 people</DeltaChip>
							<DeltaChip dir="down">2 pts</DeltaChip>
							<DeltaChip dir="up" tone="risk">
								3 overdue
							</DeltaChip>
							<DeltaChip dir="up" size="sm">
								12%
							</DeltaChip>
						</div>
						<div className="flex flex-wrap gap-2">
							<Tag tone="green" icon={MusicNote01Icon}>
								Worship
							</Tag>
							<Tag tone="blue">Hospitality</Tag>
							<Tag tone="violet">Small groups</Tag>
							<Tag tone="amber">Kids</Tag>
							<Tag tone="teal">Prayer</Tag>
							<Tag>Volunteer</Tag>
						</div>
					</div>
				</Specimen>
				<Specimen>
					<div className="flex flex-col gap-4">
						<div className="flex flex-wrap gap-2">
							{STAGES.map((s) => (
								<StageChip key={s} stage={s} />
							))}
						</div>
						<div className="flex flex-wrap items-center gap-4">
							<Avatar name="Daniel Reyes" tone="green" size="xs" />
							<Avatar name="Maria Santos" tone="blue" size="sm" />
							<Avatar name="James Okafor" tone="amber" />
							<Avatar name="Ana Lee" tone="violet" size="lg" />
							<Avatar name="Maria Santos" tone="ink" size="xl" ring />
							<AvatarGroup
								people={[
									{ name: "Maria Santos", tone: "blue" },
									{ name: "James Okafor", tone: "amber" },
									{ name: "Ana Lee", tone: "green" },
									...Array.from({ length: 8 }, (_, i) => ({ name: `Guest ${i + 1}` })),
								]}
							/>
						</div>
					</div>
				</Specimen>
			</Grid>
		</Section>
	);
}

export function StatsSection({ index }: { index: number }) {
	return (
		<Section
			index={index}
			title="Stats, meters and lists"
			code="<Stat> <StatStrip> <Metric zero> <TargetBar> <Progress> <Meter> <Ring> <KeyValue> <ListRow> <Legend> <CoverageBar>"
			note="A count that nobody recorded says “Not recorded”; a real zero shows 0 with what will make it grow."
		>
			<Grid cols={3}>
				<Specimen>
					<Stat
						label="Core group"
						value={34}
						size="xl"
						delta={<DeltaChip dir="up">9</DeltaChip>}
						caption="16 committed adults to the 50 benchmark. The Playbook aims for 50 to 100."
					>
						<TargetBar
							className="mt-6"
							label="Core group toward the benchmark"
							value={34}
							max={60}
							target={50}
							targetLabel="Benchmark 50"
						/>
					</Stat>
				</Specimen>
				<Specimen>
					<KeyValueList>
						<KeyValue
							k="Vision meetings"
							value={6}
							delta={
								<DeltaChip dir="up" size="sm">
									2
								</DeltaChip>
							}
						/>
						<KeyValue
							k="Avg attendance"
							value={41}
							delta={
								<DeltaChip dir="up" size="sm">
									12%
								</DeltaChip>
							}
						/>
						<KeyValue k="First-time guests" value={null} />
						<KeyValue
							k="Followed up in 48 h"
							value="71%"
							delta={
								<DeltaChip dir="down" size="sm">
									8%
								</DeltaChip>
							}
						/>
					</KeyValueList>
					<div className="mt-4 flex flex-col gap-2">
						<Progress label="Followed up in 48 hours" value={71} />
						<Progress label="Interviews done" value={48} size="sm" tone="blue" />
						<div className="mt-2 flex gap-4">
							<Ring label="Followed up" value={71} />
							<Ring label="Roles filled" value={4} max={10} display="4/10" tone="amber" />
							<Ring label="Trained" value={90} tone="blue" />
						</div>
					</div>
				</Specimen>
				<Specimen title="Needs you" description="4 things this week">
					<List>
						<ListRow
							icon={Alert02Icon}
							tone="magenta"
							title="3 follow-ups overdue"
							subtitle="Kim Wu is 3 days late"
							urgent
							href="#needs"
						/>
						<ListRow
							icon={CheckmarkCircle02Icon}
							tone="amber"
							title="2 interviews to record"
							subtitle="Held last week"
							href="#needs"
						/>
						<ListRow
							icon={Calendar03Icon}
							tone="blue"
							title="Agenda for Oct 12"
							subtitle="Vision meeting #12"
							href="#needs"
						/>
					</List>
				</Specimen>
				<Specimen title="Core group" description="Committed adults">
					<ZeroMetric>
						The Playbook aims for 50 to 100 adults who share the vision before launch. Your count starts when someone
						commits.
					</ZeroMetric>
					<Progress label="Core group toward the benchmark" value={0} size="sm" className="mt-4" />
				</Specimen>
				<Specimen title="Evidence" description="How much of the portfolio each insight can see">
					<CoverageBar category="Findings" n={11} total={14} />
					<CoverageBar category="People" n={12} total={14} />
					<CoverageBar category="Wiki reading" n={7} total={14} />
					<p className="mt-2.5 text-xs text-text-3">
						Plants that do not share a category count as unknown, never as zero.
					</p>
				</Specimen>
				<Specimen title="Legend">
					<Legend
						items={[
							{ label: "Lost", tone: "magenta", count: 7 },
							{ label: "At risk", tone: "amber", count: 14 },
							{ label: "Returning", tone: "blue", count: 10 },
							{ label: "Committed", tone: "green", count: 31 },
						]}
					/>
					<Legend
						className="mt-4"
						items={[
							{ label: "History", tone: "blue", mark: "hatch" },
							{ label: "This meeting", tone: "blue", mark: "swatch" },
						]}
					/>
				</Specimen>
			</Grid>
			<Specimen className="mt-5">
				<StatStrip>
					<Stat label="People" value={214} caption="12 new this month" />
					<Stat
						label="Core group"
						value={34}
						delta={
							<DeltaChip dir="up" size="sm">
								9
							</DeltaChip>
						}
					/>
					<Stat label="Guests last Sunday" value={null} caption="Attendance not finalized" />
					<Stat label="Leaders" value={6} caption="of 8 roles" />
				</StatStrip>
			</Specimen>
		</Section>
	);
}

type DataState = "ready" | "loading" | "error" | "empty";
const DATA_STATES = [
	{ value: "ready", label: "Ready" },
	{ value: "loading", label: "Loading" },
	{ value: "error", label: "Error" },
	{ value: "empty", label: "Empty" },
] as const satisfies readonly { value: DataState; label: string }[];

export function TableSection({ index }: { index: number }) {
	const [dataState, setDataState] = useState<DataState>("ready");
	const [selected, setSelected] = useState<Set<string>>(() => new Set(["james"]));
	const [page, setPage] = useState(1);
	const state: Loadable<Person[]> = useMemo(() => {
		switch (dataState) {
			case "loading":
				return { status: "loading" };
			case "error":
				return {
					status: "error",
					title: "People did not load",
					onRetry: () => setDataState("ready"),
					meta: "Last loaded today at 8:40 am · Error reference EF-7Q2K",
				};
			case "empty":
				return { status: "ready", data: [] };
			case "ready":
				return { status: "ready", data: PEOPLE };
		}
	}, [dataState]);
	return (
		<Section
			index={index}
			title="Table"
			code="<DataTable state selection highlight> <Pagination> <BulkBar>"
			note="A real table with a caption. Below the content width it scrolls sideways in a focusable region. The data state switch shows the loading, error and empty states every loaded component shares."
		>
			<Specimen
				title="People"
				description="Select rows to see the bulk bar"
				action={
					<SegmentedControl
						label="Data state"
						size="sm"
						options={[...DATA_STATES]}
						value={dataState}
						onValueChange={setDataState}
					/>
				}
			>
				<DataTable
					caption="People"
					state={state}
					rowId={(p) => p.id}
					rowLabel={(p) => `Select ${p.name}`}
					selection={{ selected, onChange: setSelected }}
					empty={{
						icon: UserMultipleIcon,
						title: "No people yet",
						text: "Add the people you already know, or import a spreadsheet.",
					}}
					columns={[
						{
							key: "person",
							header: "Person",
							cell: (p) => (
								<div className="flex items-center gap-3">
									<Avatar name={p.name} tone={p.tone} size="sm" decorative />
									<div>
										<a href={`#person-${p.id}`} className="font-medium text-ink hover:underline">
											{p.name}
										</a>
										<div className="mt-0.5 text-sm text-text-3">{p.household}</div>
									</div>
								</div>
							),
						},
						{ key: "stage", header: "Stage", cell: (p) => <StageChip stage={p.stage} /> },
						{
							key: "contact",
							header: "Last contact",
							cell: (p) => <span className={p.overdue ? "text-magenta-600" : undefined}>{p.lastContact}</span>,
						},
						{
							key: "ministry",
							header: "Ministries",
							cell: (p) =>
								p.ministry ? (
									<Tag tone={p.ministry.tone}>{p.ministry.name}</Tag>
								) : (
									<span className="text-text-3">None</span>
								),
						},
						{ key: "meetings", header: "Meetings", cell: (p) => p.meetings, align: "right", numeric: true },
						{
							key: "go",
							header: "Open",
							srOnlyHeader: true,
							align: "right",
							cell: () => <Icon icon={ArrowRight01Icon} size={16} className="ml-auto text-text-3" />,
						},
					]}
				/>
				{state.status === "ready" && state.data.length ? (
					<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
						<span className="text-text-3">Showing 3 of 214 people</span>
						<Pagination page={page} pageCount={9} onPageChange={setPage} label="People pages" />
					</div>
				) : null}
				<BulkBar
					className="mt-4"
					count={state.status === "ready" ? state.data.filter((p) => selected.has(p.id)).length : 0}
					noun={["person", "people"]}
					actions={[
						{ label: "Complete", icon: Tick02Icon, onClick: () => undefined },
						{ label: "Reschedule", icon: Calendar03Icon, onClick: () => undefined },
						{ label: "Reassign", icon: UserIcon, onClick: () => undefined },
					]}
					onClear={() => setSelected(new Set())}
				/>
			</Specimen>
		</Section>
	);
}
