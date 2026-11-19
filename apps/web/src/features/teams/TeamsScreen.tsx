"use client";

import {
	Add01Icon,
	Alert02Icon,
	GridViewIcon,
	HierarchyIcon,
	LayoutGridIcon,
	UserGroupIcon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	EmptyState,
	InsightCard,
	InsightPill,
	InsightText,
	InsightTitle,
	InsightTop,
	PageHeader,
	SegmentedControl,
	StatePanel,
	Switch,
	toast,
} from "@everyfield/ui/controls";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useAddress, writeAddress } from "../../components/location.ts";
import { NoticeInDialog, SaveNotice, useSaveIntent } from "../../components/save/parts.tsx";
import { createTeam, reloadTeams } from "./actions.ts";
import { optional, TeamDialog, type TeamForm } from "./dialogs.tsx";
import { isLeadership, newSetup, plural, problemText, type SetupForm, type Team } from "./model.ts";
import { OrgChart } from "./OrgChart.tsx";
import { MinistryCard } from "./parts.tsx";
import type { TeamView, TeamsView } from "./server.ts";
import { TeamScreen } from "./TeamScreen.tsx";
import { SetupDialog } from "./Setup.tsx";

type TeamsTab = "teams" | "chart";
const NEW_TEAM: TeamForm = { mode: "create", name: "", description: "", icon: "team", state: "forming", reason: "" };

export function TeamsScreen({ view: initial, admin }: { view: TeamsView; admin: boolean }) {
	const router = useRouter();
	const [local, setLocal] = useState<{ from: TeamsView; value: TeamsView } | null>(null);
	const view = local?.from === initial ? local.value : initial;
	const [draft, setDraft] = useState<TeamView | null>(null);
	const { pathname, params } = useAddress();
	const tab: TeamsTab = params.get("view") === "chart" ? "chart" : "teams";
	const [archived, setArchived] = useState(false);
	const createLane = useSaveIntent<TeamForm>({ explain: problemText });
	const setupLane = useSaveIntent<SetupForm>({ explain: problemText });
	const choose = (next: TeamsTab) =>
		writeAddress(next === "chart" ? `${pathname}?view=chart` : pathname, { replace: true });

	const teams = view.teams;
	const current = teams?.filter((t) => !t.archived) ?? [];
	const gone = teams?.filter((t) => t.archived) ?? [];
	const present = new Set((teams ?? []).flatMap((t) => (t.templateKey ? [t.templateKey] : [])));
	const leaderless = current.filter((t) => !t.leaderPersonId);
	const led = current.length - leaderless.length;
	const filled = current.reduce((n, t) => n + t.activeCount, 0);
	const ordered = [...current.filter(isLeadership), ...current.filter((t) => !isLeadership(t))];

	const [refreshing, startRefresh] = useTransition();
	const refresh = () =>
		startRefresh(async () => {
			const r = await reloadTeams().catch(() => ({ status: "lost" }) as const);
			if (r.status === "ok") setLocal({ from: initial, value: r.value });
			else
				toast({
					tone: "error",
					message: "The new ministries are saved, but the list did not update. Reload the page.",
				});
		});

	function create(form: TeamForm) {
		setDraft(openedMinistry(form, view.nodes, admin));
		void createLane.save({
			what: `The ministry ${form.name.trim()}`,
			done: "created",
			form,
			send: (key) =>
				createTeam(key, {
					name: form.name.trim(),
					description: optional(form.description),
					icon: form.icon,
					state: form.state,
				}),
			ok: (result) => {
				router.push(`/ministries/${result.team.id}`);
			},
			refused: () => setDraft(null),
		});
	}

	const setup = admin ? (
		<Button variant="secondary" icon={LayoutGridIcon} onClick={() => setupLane.open(newSetup())}>
			Set up from templates
		</Button>
	) : null;
	const newTeam = admin ? (
		<Button variant="primary" icon={Add01Icon} onClick={() => createLane.open(NEW_TEAM)}>
			New ministry
		</Button>
	) : null;

	if (draft) {
		return (
			<>
				<SaveNotice {...createLane.noticeProps} dialogOpen={createLane.editing !== null} />
				<TeamScreen data={draft} />
			</>
		);
	}

	return (
		<>
			<PageHeader
				size="xl"
				title="Ministries"
				subtitle="The teams that serve, who leads them and how many people serve on each."
				actions={
					<>
						<SegmentedControl
							label="View"
							options={[
								{ value: "teams", label: "Ministries", icon: GridViewIcon },
								{ value: "chart", label: "Organization view", icon: HierarchyIcon },
							]}
							value={tab}
							onValueChange={choose}
						/>
						{setup}
						{newTeam}
					</>
				}
			/>
			<SaveNotice {...createLane.noticeProps} dialogOpen={createLane.editing !== null} />
			<SaveNotice {...setupLane.noticeProps} dialogOpen={setupLane.editing !== null} />
			{setupLane.saving || refreshing ? (
				<p role="status" className="mb-4 text-sm text-text-2">
					Adding the ministries you chose…
				</p>
			) : null}
			{teams === null ? (
				<Card>
					<StatePanel tone="error" title="Ministries did not load" headingLevel="h2">
						This is a loading problem, not an empty list. Nothing was changed. Reload the page in a moment.
					</StatePanel>
				</Card>
			) : tab === "chart" ? (
				<Card>
					<OrgChart nodes={view.nodes} onAdd={admin ? () => setupLane.open(newSetup()) : undefined} />
				</Card>
			) : teams.length === 0 ? (
				<Card>
					<EmptyState
						icon={UserGroupIcon}
						title="No ministries yet"
						headingLevel="h2"
						action={
							admin ? (
								<span className="flex flex-wrap justify-center gap-2.5">
									{setup}
									<Button variant="secondary" icon={Add01Icon} onClick={() => createLane.open(NEW_TEAM)}>
										Create your own
									</Button>
								</span>
							) : undefined
						}
					>
						{admin
							? "Start from the ten Playbook ministries and pick only the roles you need, or create your own. Nothing is added until you choose."
							: "When an Owner or Admin adds ministries, they appear here."}
					</EmptyState>
				</Card>
			) : (
				<div className="flex flex-col gap-5">
					<div className="grid grid-cols-[1fr_1fr_1.15fr] gap-5 max-app-lg:grid-cols-2 max-app-sm:grid-cols-1">
						<Stat label="Leaders in place" value={`${led}`} of={current.length} hint={leaderHint(leaderless.length)} />
						<Stat
							label="Roles filled"
							value={`${filled}`}
							hint={filled === 0 ? "No one serves in a role yet." : "One person in each filled role."}
						/>
						{leaderless.length ? (
							<InsightCard
								tone="rose"
								size="sm"
								aria-labelledby="leaderless-title"
								className="max-app-lg:col-span-2 max-app-sm:col-span-1"
							>
								<InsightTop>
									<InsightPill icon={Alert02Icon}>Needs a leader</InsightPill>
								</InsightTop>
								<InsightTitle id="leaderless-title" size="sm">
									{leaderless.length === 1
										? `${leaderless[0]!.name} has no leader`
										: `${plural(leaderless.length, "ministry", "ministries")} have no leader`}
								</InsightTitle>
								<InsightText className="wrap-anywhere">
									{leaderless.length === 1
										? "Open it to appoint someone, or fill a leadership role."
										: `${leaderless
												.slice(0, 4)
												.map((t) => t.name)
												.join(", ")}${leaderless.length > 4 ? ` and ${leaderless.length - 4} more` : ""}.`}
								</InsightText>
							</InsightCard>
						) : null}
					</div>
					{ordered.length ? (
						<section aria-label="Current ministries">
							<ul className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-4">
								{ordered.map((t) => (
									<li key={t.id} className="flex">
										<MinistryCard team={t} />
									</li>
								))}
							</ul>
						</section>
					) : (
						<Card>
							<EmptyState icon={UserGroupIcon} title="Every ministry is archived" headingLevel="h2">
								Show archived ministries to see them and restore one.
							</EmptyState>
						</Card>
					)}
					{gone.length ? (
						<section aria-labelledby="archived-title" className="flex flex-col gap-4">
							<div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
								<h2 id="archived-title" className="font-title text-title-sm text-ink">
									Archived ministries
								</h2>
								<Switch checked={archived} onCheckedChange={setArchived} label={`Show ${gone.length} archived`} />
							</div>
							{archived ? (
								<ul className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-4">
									{gone.map((t) => (
										<li key={t.id} className="flex">
											<MinistryCard team={t} />
										</li>
									))}
								</ul>
							) : (
								<p className="text-sm text-text-3">
									Archived ministries keep their history. They are not on the chart or in counts.
								</p>
							)}
						</section>
					) : null}
				</div>
			)}
			{admin ? (
				<NoticeInDialog {...createLane.noticeProps}>
					{createLane.editing ? (
						<TeamDialog
							form={createLane.editing}
							problem={createLane.problem}
							wait={createLane.wait}
							onClose={createLane.close}
							onSubmit={create}
						/>
					) : null}
				</NoticeInDialog>
			) : null}
			{admin ? (
				<NoticeInDialog {...setupLane.noticeProps}>
					<SetupDialog
						lane={setupLane}
						present={present}
						onDone={(added) => {
							choose("teams");
							refresh();
							toast({
								tone: "success",
								message:
									added.newTeams || added.newRoles
										? `Added ${plural(added.newTeams, "ministry", "ministries")} and ${plural(added.newRoles, "role")}.`
										: "Everything you chose was already here. Nothing was added.",
							});
						}}
					/>
				</NoticeInDialog>
			) : null}
		</>
	);
}

function openedMinistry(form: TeamForm, nodes: TeamView["nodes"], admin: boolean): TeamView {
	const id = crypto.randomUUID() as Team["id"];
	return {
		status: "found",
		team: {
			id,
			revision: "1" as Team["revision"],
			name: form.name.trim(),
			description: optional(form.description),
			icon: form.icon,
			templateKey: null,
			state: form.state,
			archived: false,
			sortOrder: 0,
			leaderPersonId: null,
			leaderSource: null,
			leaderRoleId: null,
			activeCount: 0,
			leaderName: null,
		},
		nodes,
		roles: [],
		members: [],
		past: [],
		meetings: { items: [], total: 0 },
		now: new Date().toISOString(),
		canChange: false,
		admin,
	};
}

const leaderHint = (missing: number) =>
	missing === 0
		? "Every current ministry has a leader."
		: `${plural(missing, "ministry", "ministries")} need a leader.`;

function Stat({ label, value, of, hint }: { label: string; value: string; of?: number; hint: string }) {
	return (
		<Card>
			<p className="text-sm font-medium text-text-2">{label}</p>
			<p className="mt-3 flex items-end gap-1 font-title text-ink">
				<span className="text-[44px] leading-none tracking-[-0.03em] tabular-nums">{value}</span>
				{of !== undefined ? <span className="pb-1 text-title-md text-text-3 tabular-nums">/{of}</span> : null}
			</p>
			<p className="mt-3 text-md text-text-2">{hint}</p>
		</Card>
	);
}
