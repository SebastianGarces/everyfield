"use client";

import { ArrowLeft01Icon, CrownIcon, LayoutGridIcon } from "@hugeicons/core-free-icons";
import {
	Button,
	Checkbox,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Spinner,
	StatePanel,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { useEffect, useState } from "react";
import { DialogNotice, SaveButton, type SaveIntent } from "../../components/save/parts.tsx";
import { importTemplates, templateCatalog } from "./actions.ts";
import { plural, type Catalog, type Outcome } from "./model.ts";

// Set up ministries from the ten templates (REQ-TEAM-003). Nothing is created until the person reviews the exact
// ministries and roles and confirms. Choosing nothing, closing or going back creates nothing. A template that is
// already here only adds the roles it does not have yet; a renamed ministry keeps its name.
// With `into` the same dialog adds roles to that one ministry: its own template comes first and is preselected, a role
// it already has cannot be chosen again, and no ministry is created.

/** `chosen` is null until the person changes a choice: then the default applies (nothing, or the `into` template). */
export type SetupForm = { chosen: Record<string, string[]> | null; step: "choose" | "review"; problem?: string };
export const NEW_SETUP: SetupForm = { chosen: null, step: "choose" };

export type SetupInto = {
	id: string;
	name: string;
	/** The ministry's own template, when it has one. */
	templateKey: string | null;
	/** Template role keys the ministry already has, retired ones too. */
	has: ReadonlySet<string>;
};

const NONE: ReadonlySet<string> = new Set();

export function SetupDialog({
	lane,
	present = NONE,
	into,
	onDone,
}: {
	lane: SaveIntent<SetupForm>;
	/** Template keys this church already has, archived ones too. Not needed with `into`. */
	present?: ReadonlySet<string>;
	into?: SetupInto;
	onDone: (added: { newTeams: number; newRoles: number }) => void;
}) {
	const form = lane.editing;
	const [catalog, setCatalog] = useState<Outcome<Catalog> | null>(null);
	const [f, setF] = useState<SetupForm>(form ?? NEW_SETUP);
	const open = form !== null;
	// Each time the dialog opens it starts from the form it was opened with, even when
	// that is the same shared object as last time.
	const [wasOpen, setWasOpen] = useState(open);
	if (open !== wasOpen) {
		setWasOpen(open);
		if (form) setF(form);
	}
	useEffect(() => {
		if (!open || catalog?.status === "ok") return;
		let live = true;
		templateCatalog().then(
			(r) => live && setCatalog(r),
			() => live && setCatalog({ status: "lost" }),
		);
		return () => {
			live = false;
		};
	}, [open, catalog?.status]);

	const all = catalog?.status === "ok" ? catalog.value.teams : [];
	const teams = into
		? [...all.filter((t) => t.key === into.templateKey), ...all.filter((t) => t.key !== into.templateKey)].filter(
				(t) => t.roles.length > 0,
			)
		: all;
	const has = into?.has;
	const fresh = (t: (typeof teams)[number]) => t.roles.filter((r) => !has?.has(r.key)).map((r) => r.key);
	const chosen: Record<string, string[]> =
		f.chosen ??
		Object.fromEntries(
			into ? teams.filter((t) => t.key === into.templateKey && fresh(t).length).map((t) => [t.key, fresh(t)]) : [],
		);
	const selections = teams
		.filter((t) => chosen[t.key] && (!into || chosen[t.key]!.length > 0))
		.map((t) => ({
			teamKey: t.key,
			roleKeys: t.roles.filter((r) => chosen[t.key]!.includes(r.key)).map((r) => r.key),
			...(into ? { destinationTeamId: into.id } : {}),
		}));
	const newTeams = into ? 0 : selections.filter((s) => !present.has(s.teamKey)).length;
	const roleCount = selections.reduce((n, s) => n + s.roleKeys.length, 0);
	// A template that is already here with no role chosen would add nothing.
	const nothing = newTeams === 0 && roleCount === 0;

	const toggleTeam = (key: string, on: boolean) =>
		setF((x) => {
			const next = { ...chosen };
			if (on) next[key] = fresh(teams.find((t) => t.key === key)!);
			else delete next[key];
			return { ...x, chosen: next };
		});
	const toggleRole = (team: string, role: string, on: boolean) =>
		setF((x) => {
			const now = chosen[team] ?? [];
			return { ...x, chosen: { ...chosen, [team]: on ? [...now, role] : now.filter((r) => r !== role) } };
		});

	async function confirm() {
		if (catalog?.status !== "ok" || nothing) return;
		const version = catalog.value.version;
		const kept = f;
		await lane.save({
			what: into ? "The roles" : "The ministries",
			done: "added",
			form: { ...kept, chosen },
			send: (key) => importTemplates(key, version, selections),
			ok: onDone,
			refused: (code) => code === "stale_template_version" && setCatalog(null),
		});
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !next && lane.close()}>
			<DialogContent size="md">
				<DialogHeader
					icon={LayoutGridIcon}
					title={
						f.step === "review"
							? "Review what will be added"
							: into
								? "Set up roles from templates"
								: "Set up ministries"
					}
					description={
						f.step === "choose"
							? into
								? `Choose the roles to add to ${into.name}. You can edit or retire them later.`
								: "Choose the ministries and roles you want. You can add more later, or create your own instead."
							: into
								? `Only these roles are added to ${into.name}. No ministry is created and nothing else changes.`
								: "Only these rows are created. Nothing else changes."
					}
				/>
				<DialogBody className="flex flex-col gap-4 pb-1">
					<DialogNotice />
					{lane.problem ? (
						<p role="alert" className="rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600">
							{lane.problem}
						</p>
					) : null}
					{catalog === null ? (
						<p role="status" className="flex items-center gap-2 py-6 text-sm text-text-3">
							<Spinner size={16} /> Loading the templates…
						</p>
					) : catalog.status !== "ok" ? (
						<StatePanel tone="error" title="The templates did not load" headingLevel="h3">
							Nothing was changed. Close this and try again in a moment.
						</StatePanel>
					) : f.step === "choose" ? (
						<ul className="flex flex-col divide-y divide-line">
							{teams.map((t) => {
								const on = chosen[t.key] !== undefined;
								const here = !into && present.has(t.key);
								const left = fresh(t).length;
								return (
									<li key={t.key} className="py-1">
										<div className="flex items-center justify-between gap-3">
											<Checkbox
												checked={on}
												disabled={!!into && left === 0}
												onCheckedChange={(v) => toggleTeam(t.key, v === true)}
												label={into && t.key === into.templateKey ? `${t.name} (this ministry's template)` : t.name}
												description={
													into
														? left === 0
															? "This ministry has all of its roles."
															: `${plural(left, "role")} to add`
														: t.roles.length === 0
															? "No starter role. Add your own roles later."
															: plural(t.roles.length, "starter role")
												}
											/>
											{here ? (
												<StatusBadge status="measured" size="sm">
													Already set up
												</StatusBadge>
											) : null}
										</div>
										{on && t.roles.length ? (
											<fieldset className="mb-2 ml-8 flex flex-col">
												<legend className="sr-only">Roles for {t.name}</legend>
												{t.roles.map((r) => {
													const have = !!has?.has(r.key);
													return (
														<div key={r.key} className="flex items-center justify-between gap-3">
															<Checkbox
																checked={have || chosen[t.key]!.includes(r.key)}
																disabled={have}
																onCheckedChange={(v) => toggleRole(t.key, r.key, v === true)}
																label={
																	<span className="flex items-center gap-1.5">
																		{r.name}
																		{r.leadership ? (
																			<>
																				<Icon icon={CrownIcon} size={16} className="text-amber-600" />
																				<span className="sr-only">, leadership role</span>
																			</>
																		) : null}
																	</span>
																}
															/>
															{have ? (
																<StatusBadge status="measured" size="sm">
																	Already here
																</StatusBadge>
															) : null}
														</div>
													);
												})}
											</fieldset>
										) : null}
									</li>
								);
							})}
						</ul>
					) : (
						<ul className="flex flex-col gap-3">
							{selections.map((s) => {
								const t = teams.find((x) => x.key === s.teamKey)!;
								const here = present.has(s.teamKey);
								return (
									<li key={s.teamKey} className="rounded-md bg-surface-2 px-4 py-3">
										<p className="font-medium text-ink">
											{into
												? `Adds ${plural(s.roleKeys.length, "role")} to ${into.name}`
												: here
													? `Adds to your ${t.name} ministry`
													: `New ministry: ${t.name}`}
										</p>
										<p className="mt-0.5 text-sm text-text-2">
											{s.roleKeys.length === 0
												? "No roles."
												: `Roles: ${t.roles
														.filter((r) => s.roleKeys.includes(r.key))
														.map((r) => r.name)
														.join(", ")}${here && !into ? ". A role it already has is skipped." : ""}`}
										</p>
									</li>
								);
							})}
						</ul>
					)}
				</DialogBody>
				<DialogFooter>
					{f.step === "review" ? (
						<Button
							variant="secondary"
							icon={ArrowLeft01Icon}
							onClick={() => setF((x) => ({ ...x, chosen, step: "choose" }))}
						>
							Back
						</Button>
					) : (
						<Button variant="secondary" onClick={lane.close}>
							Cancel
						</Button>
					)}
					{f.step === "choose" ? (
						<Button
							variant="primary"
							disabled={nothing}
							onClick={() => setF((x) => ({ ...x, chosen, step: "review" }))}
						>
							Review
						</Button>
					) : (
						<form
							className="contents"
							onSubmit={(e) => {
								e.preventDefault();
								void confirm();
							}}
						>
							<SaveButton wait={lane.wait} saving={lane.saving}>
								{newTeams > 0
									? `Add ${plural(newTeams, "ministry", "ministries")}`
									: `Add ${plural(roleCount, "role")}`}
							</SaveButton>
						</form>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
