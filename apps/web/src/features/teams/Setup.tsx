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
import { importTemplates, reviewTemplates, templateCatalog } from "./actions.ts";
import { plural, type Catalog, type Outcome } from "./model.ts";
import type { TeamsView } from "./server.ts";

// Set up ministries from the ten templates (REQ-TEAM-003). Nothing is created until the person reviews the exact
// ministries and roles and confirms. Choosing nothing, closing or going back creates nothing. A template that is
// already here only adds the roles it does not have yet; a renamed ministry keeps its name.

export type SetupForm = { chosen: Record<string, string[]>; step: "choose" | "review"; problem?: string };
export const NEW_SETUP: SetupForm = { chosen: {}, step: "choose" };

export function SetupDialog({
	lane,
	present,
	onDone,
}: {
	lane: SaveIntent<SetupForm>;
	/** Template keys this church already has, archived ones too. */
	present: ReadonlySet<string>;
	onDone: (view: TeamsView, added: { newTeams: number; newRoles: number }) => void;
}) {
	const form = lane.editing;
	const [catalog, setCatalog] = useState<Outcome<Catalog> | null>(null);
	const [f, setF] = useState<SetupForm>(form ?? NEW_SETUP);
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

	const teams = catalog?.status === "ok" ? catalog.value.teams : [];
	const selections = teams
		.filter((t) => f.chosen[t.key])
		.map((t) => ({
			teamKey: t.key,
			roleKeys: t.roles.filter((r) => f.chosen[t.key]!.includes(r.key)).map((r) => r.key),
		}));
	const newTeams = selections.filter((s) => !present.has(s.teamKey)).length;
	const roleCount = selections.reduce((n, s) => n + s.roleKeys.length, 0);
	// A template that is already here with no role chosen would add nothing.
	const nothing = newTeams === 0 && roleCount === 0;

	const toggleTeam = (key: string, on: boolean) =>
		setF((x) => {
			const chosen = { ...x.chosen };
			if (on) chosen[key] = teams.find((t) => t.key === key)?.roles.map((r) => r.key) ?? [];
			else delete chosen[key];
			return { ...x, chosen };
		});
	const toggleRole = (team: string, role: string, on: boolean) =>
		setF((x) => {
			const now = x.chosen[team] ?? [];
			return { ...x, chosen: { ...x.chosen, [team]: on ? [...now, role] : now.filter((r) => r !== role) } };
		});

	async function confirm() {
		if (catalog?.status !== "ok" || nothing) return;
		const version = catalog.value.version;
		const kept = f;
		await lane.save({
			what: "The ministries",
			done: "added",
			form: kept,
			send: async (key) => {
				const review = await reviewTemplates(version, selections);
				if (review.status !== "ok") return review;
				return importTemplates(key, version, review.value.digest, selections);
			},
			ok: (v) => onDone(v.view, { newTeams: v.newTeams, newRoles: v.newRoles }),
			refused: (code) => code === "stale_template_version" && setCatalog(null),
		});
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !next && lane.close()}>
			<DialogContent size="md">
				<DialogHeader
					icon={LayoutGridIcon}
					title={f.step === "choose" ? "Set up ministries" : "Review what will be added"}
					description={
						f.step === "choose"
							? "Choose the ministries and roles you want. You can add more later, or create your own instead."
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
								const on = f.chosen[t.key] !== undefined;
								const here = present.has(t.key);
								return (
									<li key={t.key} className="py-1">
										<div className="flex items-center justify-between gap-3">
											<Checkbox
												checked={on}
												onCheckedChange={(v) => toggleTeam(t.key, v === true)}
												label={t.name}
												description={
													t.roles.length === 0
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
												{t.roles.map((r) => (
													<Checkbox
														key={r.key}
														checked={f.chosen[t.key]!.includes(r.key)}
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
												))}
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
											{here ? `Adds to your ${t.name} ministry` : `New ministry: ${t.name}`}
										</p>
										<p className="mt-0.5 text-sm text-text-2">
											{s.roleKeys.length === 0
												? "No roles."
												: `Roles: ${t.roles
														.filter((r) => s.roleKeys.includes(r.key))
														.map((r) => r.name)
														.join(", ")}${here ? ". A role it already has is skipped." : ""}`}
										</p>
									</li>
								);
							})}
						</ul>
					)}
				</DialogBody>
				<DialogFooter>
					{f.step === "review" ? (
						<Button variant="secondary" icon={ArrowLeft01Icon} onClick={() => setF((x) => ({ ...x, step: "choose" }))}>
							Back
						</Button>
					) : (
						<Button variant="secondary" onClick={lane.close}>
							Cancel
						</Button>
					)}
					{f.step === "choose" ? (
						<Button variant="primary" disabled={nothing} onClick={() => setF((x) => ({ ...x, step: "review" }))}>
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
