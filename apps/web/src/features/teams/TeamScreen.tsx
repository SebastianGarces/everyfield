"use client";

import {
	Add01Icon,
	Archive02Icon,
	ArchiveArrowUpIcon,
	CrownIcon,
	Edit02Icon,
	FileEditIcon,
	MoreHorizontalIcon,
	UserAdd01Icon,
	UserGroupIcon,
	UserRemove01Icon,
	Delete02Icon,
	Undo02Icon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	ConfirmDialog,
	EmptyState,
	IconButton,
	IntentLink,
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
	PageHeader,
	Spinner,
	StatePanel,
	Tab,
	Tabs,
	TabsList,
	TabsPanel,
	useToast,
} from "@everyfield/ui/controls";
import { Avatar } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useState, useTransition, type ReactNode } from "react";
import { NoticeInDialog, SaveNotice, useSaveIntent } from "../../components/save/parts.tsx";
import {
	appointLeader,
	assignRole,
	changeTeam,
	createRole,
	editRole,
	endMembership,
	reactivateMembership,
	reloadTeam,
	retireRole,
	teamHistory,
} from "./actions.ts";
import {
	LEADER_ICON,
	optional,
	PersonDialog,
	RoleDialog,
	roleForm,
	TeamDialog,
	type PersonForm,
	type RoleForm,
	type TeamForm,
} from "./dialogs.tsx";
import {
	changedFields,
	dayText,
	asDay,
	asPersonId,
	asRecordId,
	asRevision,
	FIELD_LABEL,
	HISTORY_KIND,
	iconKey,
	people,
	plural,
	problemText,
	shownValue,
	stampText,
	type HistoryEntry,
	type Member,
	type Outcome,
	type Role,
} from "./model.ts";
import { ChartTree } from "./OrgChart.tsx";
import { LeaderLine, TeamBadge, TeamIcon } from "./parts.tsx";
import type { TeamView } from "./server.ts";

// One ministry (REQ-TEAM-001, -002, -004 to -006): its roles, its people now and before, its leader, its place in the
// organization view and its history. Every change shows at once, then the page takes the server's answer, which
// carries the page as it is after the change; a refusal puts the page back and says why. Nothing reloads the page.
//
// The tabs are a list so the responsibilities (WP-018) and training (WP-019) tabs join it without reshaping the page.

type Change =
	| { kind: "team"; patch: Partial<TeamView["team"]> }
	| { kind: "fill"; role: Role; person: { id: string; name: string } }
	| { kind: "leave"; personId: string }
	| { kind: "retire"; roleId: string }
	| { kind: "role"; role: Role };

function apply(v: TeamView, c: Change): TeamView {
	switch (c.kind) {
		case "team":
			return { ...v, team: { ...v.team, ...c.patch } };
		case "fill": {
			const row: Member = {
				personId: asPersonId(c.person.id),
				name: c.person.name,
				roleId: c.role.id,
				roleName: c.role.name,
				startedOn: asDay(new Date().toISOString().slice(0, 10)),
				endedOn: null,
				active: true,
				live: true,
			};
			const leads = c.role.leadership && !v.team.leaderPersonId;
			return {
				...v,
				team: leads ? { ...v.team, leaderPersonId: row.personId, leaderName: c.person.name } : v.team,
				roles:
					v.roles?.map((r) =>
						r.id === c.role.id ? { ...r, occupantPersonId: row.personId, occupantName: c.person.name } : r,
					) ?? null,
				members: v.members ? [...v.members, row] : null,
			};
		}
		case "leave":
			return {
				...v,
				roles:
					v.roles?.map((r) =>
						r.occupantPersonId === c.personId ? { ...r, occupantPersonId: null, occupantName: null } : r,
					) ?? null,
				members: v.members?.filter((m) => m.personId !== c.personId) ?? null,
			};
		case "retire":
			return { ...v, roles: v.roles?.filter((r) => r.id !== c.roleId) ?? null };
		case "role":
			return {
				...v,
				roles: v.roles?.some((r) => r.id === c.role.id)
					? v.roles.map((r) => (r.id === c.role.id ? c.role : r))
					: [...(v.roles ?? []), c.role],
			};
	}
}

type Confirm =
	| { kind: "archive" }
	| { kind: "retire"; role: Role }
	| { kind: "leave"; personId: string; name: string; roles: string[] };
type PersonFlow = { kind: "leader" } | { kind: "member"; role: Role | null };
type Saved = Outcome<{ result: unknown; view: TeamView | null }>;

export function TeamScreen({ data: loaded }: { data: TeamView }) {
	const router = useRouter();
	const toast = useToast();
	const [server, setServer] = useState(loaded);
	const [data, setData] = useState(loaded);
	if (server !== loaded) {
		setServer(loaded);
		setData(loaded);
	}
	const [, startTransition] = useTransition();
	const [view, project] = useOptimistic(data, apply);
	// One lane for the ministry itself (details, archive, leader) and one for its roles and people (C68).
	const teamLane = useSaveIntent<TeamForm>({ explain: problemText });
	const roleLane = useSaveIntent<RoleForm>({ explain: problemText });
	const peopleLane = useSaveIntent<PersonForm>({ explain: problemText });
	const [flow, setFlow] = useState<PersonFlow | null>(null);
	const [confirm, setConfirm] = useState<Confirm | null>(null);
	const [tab, setTab] = useState("roles");

	const t = view.team;
	const can = data.canChange && !t.archived;
	const roles = view.roles?.filter((r) => !r.retired) ?? null;
	const retired = view.roles?.filter((r) => r.retired).length ?? 0;
	const open = roles?.filter((r) => !r.occupantPersonId) ?? [];
	const crew = view.members ? people(view.members) : null;

	/** After a refusal as out of date: the latest page, shown. A ministry that is gone goes back to the list. */
	const stale = () =>
		reloadTeam(t.id).then(
			(r) => {
				if (r.status !== "ok") return;
				if (r.value) setData(r.value);
				else router.push("/ministries");
			},
			() => {},
		);
	/** The confirmed page after a change, or the list when the ministry is no longer here. */
	const settle = (next: TeamView | null) =>
		startTransition(() => {
			if (next) setData(next);
			else router.push("/ministries");
		});

	function save<F extends { problem?: string }>(
		lane: ReturnType<typeof useSaveIntent<F>>,
		spec: {
			what: string;
			done?: string;
			form?: F;
			change?: Change;
			send: (key: string) => Promise<Saved>;
			ok?: (result: unknown) => void;
		},
	) {
		if (lane.wait) return;
		startTransition(async () => {
			if (spec.change) project(spec.change);
			await lane.save({
				what: spec.what,
				done: spec.done,
				form: spec.form,
				send: spec.send,
				ok: (v) => {
					settle(v.view);
					spec.ok?.(v.result);
				},
				refused: (code) => {
					if (code === "conflict") void stale();
				},
			});
		});
	}

	// The ministry ---------------------------------------------------------------------------------------------------
	const teamForm = (mode: "edit" | "correct"): TeamForm => ({
		mode,
		name: t.name,
		description: t.description ?? "",
		icon: iconKey(t),
		state: t.state,
		reason: "",
	});
	function saveTeam(form: TeamForm) {
		const patch = {
			name: form.name.trim(),
			description: optional(form.description),
			icon: form.icon,
			state: form.state,
			...(form.mode === "correct" ? { reason: form.reason.trim() } : {}),
		};
		save(teamLane, {
			what: "The ministry",
			form,
			change: {
				kind: "team",
				patch: { name: patch.name, description: patch.description, icon: patch.icon, state: patch.state },
			},
			send: (key) => changeTeam(form.mode === "correct" ? "correct" : "edit", key, t.revision, t.id, patch),
			ok: () =>
				toast({
					tone: "success",
					message: form.mode === "correct" ? "The correction is saved." : "The ministry is saved.",
				}),
		});
	}
	function archive(to: boolean) {
		save(teamLane, {
			what: "The ministry",
			done: to ? "archived" : "restored",
			change: { kind: "team", patch: { archived: to } },
			send: (key) => changeTeam(to ? "archive" : "restore", key, t.revision, t.id),
			ok: () => toast({ tone: "success", message: to ? `${t.name} is archived.` : `${t.name} is restored.` }),
		});
	}
	function appoint(form: PersonForm) {
		const person = form.person!;
		save(peopleLane, {
			what: "The leader",
			done: "appointed",
			form,
			change: {
				kind: "team",
				patch: { leaderPersonId: asPersonId(person.id), leaderName: person.name, leaderSource: "explicit" },
			},
			send: (key) => appointLeader(key, t.revision, t.id, person.id),
			ok: () => toast({ tone: "success", message: `${person.name} now leads ${t.name}.` }),
		});
	}

	// Roles and people -----------------------------------------------------------------------------------------------
	function saveRole(form: RoleForm) {
		const facts = {
			name: form.name.trim(),
			description: optional(form.description),
			leadership: form.leadership,
			timeCommitment: optional(form.timeCommitment),
			desiredSkills: optional(form.desiredSkills),
		};
		const before = roles?.find((r) => r.id === form.roleId);
		const shown: Role = {
			id: asRecordId(form.roleId ?? `pending-${crypto.randomUUID()}`),
			teamId: t.id,
			revision: asRevision(form.revision || "0"),
			templateKey: before?.templateKey ?? null,
			retired: false,
			occupantPersonId: before?.occupantPersonId ?? null,
			occupantName: before?.occupantName ?? null,
			...facts,
		};
		save(roleLane, {
			what: `The role ${facts.name}`,
			done: form.roleId ? "saved" : "added",
			form,
			change: { kind: "role", role: shown },
			send: (key) =>
				form.roleId ? editRole(key, form.revision, t.id, form.roleId, facts) : createRole(key, t.id, facts),
		});
	}
	function retire(role: Role) {
		save(roleLane, {
			what: `The role ${role.name}`,
			done: "retired",
			change: { kind: "retire", roleId: role.id },
			send: (key) => retireRole(key, role.revision, t.id, role.id),
			ok: () => toast({ tone: "success", message: `${role.name} is retired. Its history stays.` }),
		});
	}
	function fill(form: PersonForm) {
		const role = roles?.find((r) => r.id === form.roleId);
		const person = form.person!;
		if (!role) return;
		save(peopleLane, {
			what: `${person.name} in ${role.name}`,
			done: "added",
			form,
			change: { kind: "fill", role, person },
			send: (key) => assignRole(key, role.revision, t.id, role.id, person.id),
			ok: (r) => {
				const result = r as { warning: "overload" | null; teamCount: number };
				toast(
					result.warning === "overload"
						? {
								tone: "info",
								message: `${person.name} now serves on ${result.teamCount} ministries. That is allowed; check they have the time.`,
							}
						: { tone: "success", message: `${person.name} is in ${role.name}.` },
				);
			},
		});
	}
	function leave(personId: string, name: string) {
		save(peopleLane, {
			what: `${name}'s place on ${t.name}`,
			done: "ended",
			change: { kind: "leave", personId },
			send: (key) => endMembership(key, t.revision, t.id, personId),
			ok: () => toast({ tone: "success", message: `${name} is no longer on ${t.name}. Their history stays.` }),
		});
	}
	function rejoin(m: Member) {
		const role = roles?.find((r) => r.id === m.roleId);
		if (!role) return;
		save(peopleLane, {
			what: `${m.name} in ${role.name}`,
			done: "added",
			change: { kind: "fill", role, person: { id: m.personId, name: m.name } },
			send: (key) => reactivateMembership(key, role.revision, t.id, role.id, m.personId),
			ok: () => toast({ tone: "success", message: `${m.name} is back in ${role.name}.` }),
		});
	}

	const leaderNote =
		t.leaderSource === "role_derived"
			? "From a leadership role"
			: t.leaderSource === "explicit"
				? "Appointed"
				: t.leaderSource === "legacy"
					? "From an earlier record"
					: null;

	const actions = can ? (
		<>
			<Button
				variant="secondary"
				icon={LEADER_ICON}
				onClick={() => setFlow({ kind: "leader" })}
				disabled={peopleLane.wait !== null}
			>
				{t.leaderPersonId ? "Change leader" : "Appoint leader"}
			</Button>
			<Button
				variant="primary"
				icon={UserAdd01Icon}
				onClick={() => setFlow({ kind: "member", role: null })}
				disabled={open.length === 0 || peopleLane.wait !== null}
				aria-describedby={open.length === 0 ? "no-open-roles" : undefined}
			>
				Add member
			</Button>
			<Menu>
				<MenuTrigger asChild>
					<IconButton icon={MoreHorizontalIcon} label="More actions" />
				</MenuTrigger>
				<MenuContent align="end">
					<MenuItem icon={Edit02Icon} onSelect={() => teamLane.open(teamForm("edit"))}>
						Edit details
					</MenuItem>
					{data.admin ? (
						<>
							<MenuItem icon={FileEditIcon} onSelect={() => teamLane.open(teamForm("correct"))}>
								Correct the record
							</MenuItem>
							<MenuSeparator />
							<MenuItem icon={Archive02Icon} danger onSelect={() => setConfirm({ kind: "archive" })}>
								Archive ministry
							</MenuItem>
						</>
					) : null}
				</MenuContent>
			</Menu>
		</>
	) : null;

	return (
		<>
			<PageHeader
				breadcrumb={[{ label: "Ministries", href: "/ministries" }, { label: t.name }]}
				title={
					<span className="flex flex-wrap items-center gap-x-4 gap-y-2">
						<TeamIcon team={t} />
						<span className="wrap-anywhere">{t.name}</span>
						<TeamBadge team={t} />
					</span>
				}
				subtitle={t.description ?? undefined}
				actions={actions}
			/>
			{open.length === 0 && can ? (
				<p id="no-open-roles" className="sr-only">
					Every role is filled. Add a role first.
				</p>
			) : null}
			{t.archived ? (
				<Card variant="callout" tone="ink" className="mb-5 flex-row flex-wrap items-center justify-between gap-3">
					<p className="text-md text-text-2">
						<b className="font-semibold text-ink">This ministry is archived.</b> It is out of lists, counts and the
						organization view. Its roles, people and history stay as they were.
					</p>
					{data.admin && data.canChange ? (
						<Button
							variant="secondary"
							size="sm"
							icon={ArchiveArrowUpIcon}
							onClick={() => archive(false)}
							disabled={teamLane.wait !== null}
						>
							Restore
						</Button>
					) : null}
				</Card>
			) : null}
			<SaveNotice {...teamLane.noticeProps} dialogOpen={teamLane.editing !== null} />
			<SaveNotice {...roleLane.noticeProps} dialogOpen={roleLane.editing !== null} />
			<SaveNotice {...peopleLane.noticeProps} dialogOpen={flow !== null} />

			<div className="grid grid-cols-[minmax(0,1.9fr)_minmax(280px,1fr)] items-start gap-5 max-app-lg:grid-cols-1">
				<Tabs value={tab} onValueChange={setTab} className="min-w-0">
					<TabsList aria-label="Ministry">
						<Tab value="roles" count={roles?.length}>
							Roles
						</Tab>
						<Tab value="people" count={crew?.length}>
							People
						</Tab>
						<Tab value="history">History</Tab>
					</TabsList>
					<TabsPanel value="roles">
						<RolesCard
							roles={roles}
							retired={retired}
							can={can}
							busy={roleLane.wait !== null || peopleLane.wait !== null}
							onAdd={() => roleLane.open(roleForm(null))}
							onEdit={(r) => roleLane.open(roleForm(r))}
							onFill={(r) => setFlow({ kind: "member", role: r })}
							onRetire={(r) => setConfirm({ kind: "retire", role: r })}
							onLeave={(r) =>
								r.occupantPersonId &&
								setConfirm({
									kind: "leave",
									personId: r.occupantPersonId,
									name: r.occupantName ?? "This person",
									roles: roles?.filter((x) => x.occupantPersonId === r.occupantPersonId).map((x) => x.name) ?? [],
								})
							}
						/>
					</TabsPanel>
					<TabsPanel value="people">
						<PeopleCard
							crew={crew}
							past={view.past}
							roles={roles ?? []}
							can={can}
							busy={peopleLane.wait !== null}
							onLeave={(p) =>
								setConfirm({ kind: "leave", personId: p.personId, name: p.name, roles: p.roles.map((r) => r.roleName) })
							}
							onRejoin={rejoin}
						/>
					</TabsPanel>
					<TabsPanel value="history">
						<HistoryCard teamId={t.id} revision={t.revision} />
					</TabsPanel>
				</Tabs>

				<aside className="flex flex-col gap-5 max-app-lg:order-first" aria-label="Leader and organization">
					<Card>
						<CardHeader>
							<CardHeading>
								<CardTitle size="sm">Leader</CardTitle>
								{leaderNote ? <CardDescription>{leaderNote}</CardDescription> : null}
							</CardHeading>
						</CardHeader>
						<LeaderLine name={t.leaderPersonId ? (t.leaderName ?? "Leader") : null} className="text-md" />
						{!t.leaderPersonId ? (
							<p className="mt-2 text-sm text-text-2">
								Appoint someone, or fill a leadership role. The first person in a leadership role leads until someone is
								appointed.
							</p>
						) : null}
					</Card>
					<Card>
						<CardHeader>
							<CardHeading>
								<CardTitle size="sm">In the organization</CardTitle>
								<CardDescription>Not a reporting line</CardDescription>
							</CardHeading>
						</CardHeader>
						<div className="[&_a]:w-full">
							<ChartTree nodes={view.nodes} focus={t.id} />
						</div>
						<IntentLink
							href="/ministries?view=chart"
							className="mt-4 self-start text-sm font-medium text-ink underline underline-offset-4 hover:no-underline"
						>
							See the whole organization
						</IntentLink>
					</Card>
				</aside>
			</div>

			<NoticeInDialog {...teamLane.noticeProps}>
				{teamLane.editing ? (
					<TeamDialog
						form={teamLane.editing}
						problem={teamLane.problem}
						wait={teamLane.wait}
						onClose={teamLane.close}
						onSubmit={saveTeam}
					/>
				) : null}
			</NoticeInDialog>
			<NoticeInDialog {...roleLane.noticeProps}>
				{roleLane.editing ? (
					<RoleDialog
						form={roleLane.editing}
						problem={roleLane.problem}
						wait={roleLane.wait}
						onClose={roleLane.close}
						onSubmit={saveRole}
					/>
				) : null}
			</NoticeInDialog>
			<NoticeInDialog {...peopleLane.noticeProps}>
				{flow || peopleLane.editing ? (
					<PersonFlowDialog
						flow={flow ?? (peopleLane.editing?.roleId === null ? { kind: "leader" } : { kind: "member", role: null })}
						form={
							peopleLane.editing ?? { person: null, roleId: flow?.kind === "member" ? (flow.role?.id ?? null) : null }
						}
						open={open}
						teamName={t.name}
						exclude={
							flow?.kind === "member"
								? (crew?.map((p) => p.personId) ?? [])
								: t.leaderPersonId
									? [t.leaderPersonId]
									: []
						}
						problem={peopleLane.problem}
						wait={peopleLane.wait}
						onClose={() => {
							setFlow(null);
							peopleLane.close();
						}}
						onSubmit={(form, kind) => {
							setFlow(null);
							if (kind === "leader") appoint(form);
							else fill(form);
						}}
					/>
				) : null}
			</NoticeInDialog>
			<ConfirmDialog
				open={confirm !== null}
				onOpenChange={(next) => !next && setConfirm(null)}
				tone="danger"
				{...confirmCopy(confirm, t.name)}
				onConfirm={() => {
					const c = confirm;
					setConfirm(null);
					if (c?.kind === "archive") archive(true);
					if (c?.kind === "retire") retire(c.role);
					if (c?.kind === "leave") leave(c.personId, c.name);
				}}
			/>
		</>
	);
}

function confirmCopy(
	c: Confirm | null,
	team: string,
): { title: string; description?: string; consequences?: string[]; confirmLabel: string } {
	switch (c?.kind) {
		case "archive":
			return {
				title: `Archive ${team}?`,
				consequences: [
					"It leaves the ministries list, staffing counts and the organization view.",
					"Its roles, people, meetings, training and history stay. You can restore it later.",
					"Follow-ups and duties people already have stay with them.",
				],
				confirmLabel: "Archive ministry",
			};
		case "retire":
			return {
				title: `Retire the role ${c.role.name}?`,
				consequences: [
					c.role.occupantName
						? `${c.role.occupantName} stops holding this role today. Their stage, commitments and training do not change.`
						: "No one holds this role now.",
					"The role leaves the ministry. Its past holders stay in the history.",
				],
				confirmLabel: "Retire role",
			};
		case "leave":
			return {
				title: `Remove ${c.name} from ${team}?`,
				consequences: [
					c.roles.length > 1
						? `This ends all of their roles here: ${c.roles.join(", ")}.`
						: `This ends their role${c.roles[0] ? ` as ${c.roles[0]}` : ""} today.`,
					"Their stage, commitments, training and seat do not change. Their time here stays in the history.",
				],
				confirmLabel: "Remove from ministry",
			};
		default:
			return { title: "", confirmLabel: "Confirm" };
	}
}

function PersonFlowDialog({
	flow,
	form,
	open,
	teamName,
	exclude,
	problem,
	wait,
	onClose,
	onSubmit,
}: {
	flow: PersonFlow;
	form: PersonForm;
	open: Role[];
	teamName: string;
	exclude: string[];
	problem?: string;
	wait: ReturnType<typeof useSaveIntent>["wait"];
	onClose: () => void;
	onSubmit: (form: PersonForm, kind: PersonFlow["kind"]) => void;
}) {
	if (flow.kind === "leader")
		return (
			<PersonDialog
				icon={LEADER_ICON}
				title={`Appoint a leader for ${teamName}`}
				description="An appointed leader stays the leader even when leadership roles change hands."
				action="Appoint leader"
				form={{ ...form, roleId: null }}
				roles={null}
				exclude={exclude}
				problem={problem}
				wait={wait}
				note={
					<p className="text-sm text-text-2">
						A person without an account can lead a ministry. Leading gives no seat; ministry actions need a seat in this
						church.
					</p>
				}
				onClose={onClose}
				onSubmit={(f) => onSubmit(f, "leader")}
			/>
		);
	const fixed = flow.role;
	return (
		<PersonDialog
			title={fixed ? `Fill ${fixed.name}` : `Add a member to ${teamName}`}
			description={
				fixed?.desiredSkills
					? `Skills that help: ${fixed.desiredSkills}`
					: "Each role holds one person. Someone can serve on several ministries."
			}
			action={fixed ? "Fill role" : "Add member"}
			form={fixed ? { ...form, roleId: fixed.id } : form}
			roles={fixed ? null : open}
			exclude={exclude}
			problem={problem}
			wait={wait}
			onClose={onClose}
			onSubmit={(f) => onSubmit(fixed ? { ...f, roleId: fixed.id } : f, "member")}
		/>
	);
}

// Roles ----------------------------------------------------------------------------------------------------------

function RolesCard({
	roles,
	retired,
	can,
	busy,
	onAdd,
	onEdit,
	onFill,
	onRetire,
	onLeave,
}: {
	roles: Role[] | null;
	retired: number;
	can: boolean;
	busy: boolean;
	onAdd: () => void;
	onEdit: (r: Role) => void;
	onFill: (r: Role) => void;
	onRetire: (r: Role) => void;
	onLeave: (r: Role) => void;
}) {
	const filled = roles?.filter((r) => r.occupantPersonId).length ?? 0;
	const add = can ? (
		<Button variant="ghost" size="sm" icon={Add01Icon} onClick={onAdd} disabled={busy}>
			Role
		</Button>
	) : null;
	return (
		<Card as="section" aria-labelledby="roles-title">
			<CardHeader>
				<CardHeading>
					<CardTitle id="roles-title">Roles</CardTitle>
					{roles?.length ? (
						<CardDescription>
							{filled} of {roles.length} filled · one person per role
						</CardDescription>
					) : null}
				</CardHeading>
				{add}
			</CardHeader>
			{roles === null ? (
				<StatePanel tone="error" title="Roles did not load" headingLevel="h3">
					This is a loading problem. Nothing was changed. Reload the page in a moment.
				</StatePanel>
			) : roles.length === 0 ? (
				<EmptyState icon={UserGroupIcon} title="No roles yet" headingLevel="h3" action={add}>
					{can
						? "Add the roles this ministry needs. Each role is one place for one person."
						: "When roles are added, they appear here."}
				</EmptyState>
			) : (
				<ul className="grid grid-cols-2 gap-2.5 max-app-sm:grid-cols-1">
					{roles.map((r) => (
						<li key={r.id}>
							<RoleSlot
								role={r}
								can={can}
								busy={busy}
								onEdit={onEdit}
								onFill={onFill}
								onRetire={onRetire}
								onLeave={onLeave}
							/>
						</li>
					))}
				</ul>
			)}
			{retired ? (
				<p className="mt-4 text-sm text-text-3">
					{plural(retired, "retired role")} not shown. Past holders are in the People tab.
				</p>
			) : null}
		</Card>
	);
}

function RoleSlot({
	role: r,
	can,
	busy,
	onEdit,
	onFill,
	onRetire,
	onLeave,
}: {
	role: Role;
	can: boolean;
	busy: boolean;
	onEdit: (r: Role) => void;
	onFill: (r: Role) => void;
	onRetire: (r: Role) => void;
	onLeave: (r: Role) => void;
}) {
	const pending = r.id.startsWith("pending-");
	const detail = [r.occupantName ?? "Open", r.timeCommitment].filter(Boolean).join(" · ");
	return (
		<div
			aria-busy={pending || undefined}
			className={cn(
				"flex min-h-[68px] items-center gap-3 rounded-md bg-surface-2 px-3.5 py-3",
				!r.occupantPersonId &&
					"bg-transparent shadow-[inset_0_0_0_1.5px_var(--ef-line-2)] [box-shadow:inset_0_0_0_1.5px_var(--ef-line-2)]",
				pending && "opacity-60",
			)}
		>
			{r.occupantName ? (
				<Avatar name={r.occupantName} size="sm" decorative />
			) : (
				<Avatar name="" size="sm" decorative className="bg-surface shadow-none">
					<Icon icon={UserAdd01Icon} size={16} className="text-text-3" />
				</Avatar>
			)}
			<div className="min-w-0 flex-1">
				<p className="flex items-center gap-1.5 font-medium wrap-anywhere text-ink">
					{r.name}
					{r.leadership ? (
						<>
							<Icon icon={CrownIcon} size={16} className="flex-none text-amber-600" />
							<span className="sr-only">, leadership role</span>
						</>
					) : null}
				</p>
				<p className="truncate text-sm text-text-3">
					{detail}
					{!r.occupantPersonId && r.desiredSkills ? ` · ${r.desiredSkills}` : ""}
				</p>
			</div>
			{pending ? <Spinner size={16} /> : null}
			{can && !pending && !r.occupantPersonId ? (
				<Button variant="secondary" size="sm" onClick={() => onFill(r)} disabled={busy} aria-label={`Fill ${r.name}`}>
					Fill
				</Button>
			) : null}
			{can && !pending ? (
				<Menu>
					<MenuTrigger asChild>
						<IconButton icon={MoreHorizontalIcon} label={`More for ${r.name}`} size="sm" disabled={busy} />
					</MenuTrigger>
					<MenuContent align="end">
						<MenuItem icon={Edit02Icon} onSelect={() => onEdit(r)}>
							Edit role
						</MenuItem>
						{r.occupantPersonId ? (
							<MenuItem icon={UserRemove01Icon} onSelect={() => onLeave(r)}>
								Remove {r.occupantName ?? "person"} from ministry
							</MenuItem>
						) : null}
						<MenuSeparator />
						<MenuItem icon={Delete02Icon} danger onSelect={() => onRetire(r)}>
							Retire role
						</MenuItem>
					</MenuContent>
				</Menu>
			) : null}
		</div>
	);
}

// People ---------------------------------------------------------------------------------------------------------

function PeopleCard({
	crew,
	past,
	roles,
	can,
	busy,
	onLeave,
	onRejoin,
}: {
	crew: ReturnType<typeof people> | null;
	past: Member[] | null;
	roles: Role[];
	can: boolean;
	busy: boolean;
	onLeave: (p: ReturnType<typeof people>[number]) => void;
	onRejoin: (m: Member) => void;
}) {
	const here = new Set(crew?.map((p) => p.personId));
	const openIds = new Set(roles.filter((r) => !r.occupantPersonId).map((r) => r.id));
	return (
		<div className="flex flex-col gap-5">
			<Card as="section" aria-labelledby="people-title">
				<CardHeader>
					<CardHeading>
						<CardTitle id="people-title">Serving now</CardTitle>
						{crew?.length ? <CardDescription>{plural(crew.length, "person", "people")}</CardDescription> : null}
					</CardHeading>
				</CardHeader>
				{crew === null ? (
					<StatePanel tone="error" title="People did not load" headingLevel="h3">
						This is a loading problem. Nothing was changed. Reload the page in a moment.
					</StatePanel>
				) : crew.length === 0 ? (
					<EmptyState icon={UserGroupIcon} title="No one serves here yet" headingLevel="h3">
						Fill a role to add someone to this ministry.
					</EmptyState>
				) : (
					<ul className="flex flex-col divide-y divide-line">
						{crew.map((p) => (
							<li key={p.personId} className="flex items-center gap-3 py-3">
								<Avatar name={p.name} size="sm" decorative />
								<div className="min-w-0 flex-1">
									<IntentLink
										href={`/people/${p.personId}`}
										className="font-medium text-ink underline-offset-4 hover:underline focus-visible:underline"
									>
										{p.name}
									</IntentLink>
									<p className="text-sm text-text-3">
										{p.roles.map((r) => r.roleName).join(", ")} · since{" "}
										{dayText(p.roles.map((r) => r.startedOn).sort()[0]!)}
									</p>
								</div>
								{can ? (
									<Button
										variant="ghost"
										size="sm"
										icon={UserRemove01Icon}
										onClick={() => onLeave(p)}
										disabled={busy}
										aria-label={`Remove ${p.name} from ministry`}
									>
										<span className="max-app-sm:sr-only">Remove</span>
									</Button>
								) : null}
							</li>
						))}
					</ul>
				)}
			</Card>
			{past?.length ? (
				<Card as="section" aria-labelledby="past-title">
					<CardHeader>
						<CardHeading>
							<CardTitle id="past-title" size="sm">
								Served before
							</CardTitle>
							<CardDescription>Each time someone served stays here with its dates.</CardDescription>
						</CardHeading>
					</CardHeader>
					<ul className="flex flex-col divide-y divide-line">
						{past.map((m, i) => {
							const back = can && m.live && openIds.has(m.roleId) && !here.has(m.personId);
							return (
								<li key={`${m.personId}-${m.roleId}-${m.startedOn}-${i}`} className="flex items-center gap-3 py-3">
									<div className="min-w-0 flex-1">
										<p className="font-medium text-ink">
											{m.name}
											{m.live ? null : <span className="ml-2 text-sm font-normal text-text-3">Retired person</span>}
										</p>
										<p className="text-sm text-text-3">
											{m.roleName} · {dayText(m.startedOn)} to {m.endedOn ? dayText(m.endedOn) : "now"}
										</p>
									</div>
									{back ? (
										<Button
											variant="secondary"
											size="sm"
											icon={Undo02Icon}
											onClick={() => onRejoin(m)}
											disabled={busy}
											aria-label={`Bring ${m.name} back as ${m.roleName}`}
										>
											Bring back
										</Button>
									) : null}
								</li>
							);
						})}
					</ul>
				</Card>
			) : null}
		</div>
	);
}

// History --------------------------------------------------------------------------------------------------------

/** The ministry's history, read when the tab opens and again after the ministry changes. */
function HistoryCard({ teamId, revision }: { teamId: string; revision: string }) {
	const at = `${teamId}:${revision}`;
	const [got, setGot] = useState<{ at: string; value: Outcome<{ entries: HistoryEntry[] }> } | null>(null);
	useEffect(() => {
		let live = true;
		teamHistory(teamId).then(
			(value) => live && setGot({ at, value }),
			() => live && setGot({ at, value: { status: "lost" } }),
		);
		return () => {
			live = false;
		};
	}, [at, teamId]);
	return <HistoryList state={got?.at === at ? got.value : null} />;
}

function HistoryList({ state }: { state: Outcome<{ entries: HistoryEntry[] }> | null }): ReactNode {
	return (
		<Card as="section" aria-labelledby="history-title">
			<CardHeader>
				<CardHeading>
					<CardTitle id="history-title">History</CardTitle>
					<CardDescription>Every change to this ministry, newest first.</CardDescription>
				</CardHeading>
			</CardHeader>
			{state === null ? (
				<p role="status" className="flex items-center gap-2 py-4 text-sm text-text-3">
					<Spinner size={16} /> Loading the history…
				</p>
			) : state.status !== "ok" ? (
				<StatePanel tone="error" title="The history did not load" headingLevel="h3">
					Nothing was changed. Open the tab again in a moment.
				</StatePanel>
			) : state.value.entries.length === 0 ? (
				<p className="py-4 text-sm text-text-3">No changes are recorded yet.</p>
			) : (
				<ol className="flex flex-col divide-y divide-line">
					{state.value.entries.map((e) => (
						<li key={e.id} className="flex flex-col gap-1 py-3">
							<p className="flex flex-wrap items-baseline justify-between gap-2">
								<span className="font-medium text-ink">{HISTORY_KIND[e.kind] ?? "Changed"}</span>
								<time dateTime={e.occurredAt} className="text-sm text-text-3">
									{stampText(e.occurredAt)}
								</time>
							</p>
							<Diff entry={e} />
							{e.reason ? <p className="text-sm text-text-2">Reason: {e.reason}</p> : null}
						</li>
					))}
				</ol>
			)}
		</Card>
	);
}

function Diff({ entry: e }: { entry: HistoryEntry }) {
	const keys = [...new Set([...Object.keys(e.before ?? {}), ...Object.keys(e.after ?? {})])];
	const lines = keys.flatMap((k) => {
		const from = shownValue(k, e.before?.[k]);
		const to = shownValue(k, e.after?.[k]);
		return from !== null || to !== null ? [{ k, from, to }] : [];
	});
	if (!lines.length) {
		const fields = changedFields(e);
		return fields ? <p className="text-sm text-text-2">{fields}</p> : null;
	}
	return (
		<ul className="flex flex-col gap-0.5 text-sm text-text-2">
			{lines.map((l) => (
				<li key={l.k} className="wrap-anywhere">
					{FIELD_LABEL[l.k] ?? l.k}: {l.from ?? "None"} → {l.to ?? "None"}
				</li>
			))}
		</ul>
	);
}
