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
import { importRolesInto, templateCatalog } from "./actions.ts";
import { plural, type Catalog, type Outcome } from "./model.ts";

// Add roles to one ministry from the templates (REQ-TEAM-003). The same choose and review steps as the list page's
// setup, but every role goes into this ministry and no ministry is created. A role the ministry already has is shown
// and cannot be chosen again. Cancel, close and Back create nothing.

/** `chosen` is null until the person changes a choice: then the ministry's own template is preselected. */
export type RoleSetupForm = { chosen: Record<string, string[]> | null; step: "choose" | "review"; problem?: string };
export const NEW_ROLE_SETUP: RoleSetupForm = { chosen: null, step: "choose" };

export function RoleSetupDialog({
	lane,
	teamName,
	teamKey,
	here,
	teamId,
	onDone,
}: {
	lane: SaveIntent<RoleSetupForm>;
	teamName: string;
	/** The ministry's own template, when it has one. */
	teamKey: string | null;
	/** Template role keys this ministry already has, retired ones too. */
	here: ReadonlySet<string>;
	teamId: string;
	onDone: (added: { newRoles: number }) => void;
}) {
	const form = lane.editing;
	const [catalog, setCatalog] = useState<Outcome<Catalog> | null>(null);
	const [f, setF] = useState<RoleSetupForm>(form ?? NEW_ROLE_SETUP);
	const [shown, setShown] = useState(form);
	if (form && form !== shown) {
		setShown(form);
		setF(form);
	}
	const open = form !== null;
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

	// Own template first, then the others in catalog order.
	const all = catalog?.status === "ok" ? catalog.value.teams : [];
	const teams = [...all.filter((t) => t.key === teamKey), ...all.filter((t) => t.key !== teamKey)].filter(
		(t) => t.roles.length > 0,
	);
	const fresh = (t: (typeof teams)[number]) => t.roles.filter((r) => !here.has(r.key)).map((r) => r.key);
	const chosen: Record<string, string[]> =
		f.chosen ??
		Object.fromEntries(teams.filter((t) => t.key === teamKey && fresh(t).length).map((t) => [t.key, fresh(t)]));
	const selections = teams
		.filter((t) => (chosen[t.key] ?? []).length > 0)
		.map((t) => ({
			teamKey: t.key,
			roleKeys: t.roles.filter((r) => chosen[t.key]!.includes(r.key)).map((r) => r.key),
		}));
	const roleCount = selections.reduce((n, s) => n + s.roleKeys.length, 0);

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
		if (catalog?.status !== "ok" || roleCount === 0) return;
		const version = catalog.value.version;
		await lane.save({
			what: "The roles",
			done: "added",
			form: { ...f, chosen },
			send: (key) => importRolesInto(key, version, teamId, selections),
			ok: onDone,
			refused: (code) => code === "stale_template_version" && setCatalog(null),
		});
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !next && lane.close()}>
			<DialogContent size="md">
				<DialogHeader
					icon={LayoutGridIcon}
					title={f.step === "choose" ? "Set up roles from templates" : "Review what will be added"}
					description={
						f.step === "choose"
							? `Choose the roles to add to ${teamName}. You can edit or retire them later.`
							: `Only these roles are added to ${teamName}. No ministry is created and nothing else changes.`
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
								const picked = chosen[t.key];
								const open = picked !== undefined;
								const left = fresh(t).length;
								return (
									<li key={t.key} className="py-1">
										<div className="flex items-center justify-between gap-3">
											<Checkbox
												checked={open}
												disabled={left === 0}
												onCheckedChange={(v) => toggleTeam(t.key, v === true)}
												label={t.key === teamKey ? `${t.name} (this ministry's template)` : t.name}
												description={
													left === 0 ? "This ministry has all of its roles." : `${plural(left, "role")} to add`
												}
											/>
										</div>
										{open ? (
											<fieldset className="mb-2 ml-8 flex flex-col">
												<legend className="sr-only">Roles from {t.name}</legend>
												{t.roles.map((r) => {
													const has = here.has(r.key);
													return (
														<div key={r.key} className="flex items-center justify-between gap-3">
															<Checkbox
																checked={has || picked.includes(r.key)}
																disabled={has}
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
															{has ? (
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
								return (
									<li key={s.teamKey} className="rounded-md bg-surface-2 px-4 py-3">
										<p className="font-medium text-ink">
											Adds {plural(s.roleKeys.length, "role")} to {teamName}
										</p>
										<p className="mt-0.5 text-sm text-text-2">
											{t.roles
												.filter((r) => s.roleKeys.includes(r.key))
												.map((r) => r.name)
												.join(", ")}
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
							disabled={roleCount === 0}
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
								{`Add ${plural(roleCount, "role")}`}
							</SaveButton>
						</form>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
