"use client";

import {
	Alert02Icon,
	ArrowRight01Icon,
	Calendar03Icon,
	CheckmarkCircle02Icon,
	MusicNote01Icon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { useMemo, useState } from "react";
import { SegmentedControl } from "../../controls";
import { Icon } from "../../foundations";
import {
	Avatar,
	AvatarGroup,
	DataTable,
	DeltaChip,
	KeyValue,
	KeyValueList,
	List,
	ListRow,
	Pagination,
	StageChip,
	StatusBadge,
	STAGES,
	Tag,
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

export function ListsSection({ index }: { index: number }) {
	return (
		<Section
			index={index}
			title="Key values and lists"
			code="<KeyValueList> <KeyValue> <List> <ListRow>"
			note="A count that nobody recorded says “Not recorded”; a real zero shows 0."
		>
			<Grid cols={2}>
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
						<KeyValue k="Based on" value="Everyfield global v4" size="sm" />
					</KeyValueList>
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
			</Grid>
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
			</Specimen>
		</Section>
	);
}
