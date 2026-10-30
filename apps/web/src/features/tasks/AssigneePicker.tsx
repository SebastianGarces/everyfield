"use client";

import { MAX_ASSIGNEES } from "@everyfield/contracts/tasks";
import { Combobox } from "@everyfield/ui/controls";
import { useEffect, useState } from "react";
import { assigneeOptions } from "./fetch.ts";

type Purpose = "any" | "committed_follow_up";
/** An account already on the record, with the warning it earns when it is no longer an eligible choice. */
export type Held = { accountId: string; displayName: string; warning?: string | null };

// The church's seats change rarely, so one read serves every picker on this page; a failed read is forgotten, so the
// next use tries again. Intent on a button that opens a picker starts it, so the list is there when it opens.
const seats: Partial<Record<Purpose, ReturnType<typeof assigneeOptions>>> = {};
export const warmAssignees = (purpose: Purpose = "any") =>
	(seats[purpose] ??= assigneeOptions(purpose)
		.catch(() => ({ status: "lost" }) as const)
		.then((r) => {
			if (r.status !== "ok") delete seats[purpose];
			return r;
		}));
/** After a refusal that names an account as ineligible, the next read asks again. */
export const forgetAssignees = () => {
	delete seats.any;
	delete seats.committed_follow_up;
};

/**
 * Choose up to ten people for a task or follow-up (REQ-TSK-002). The list holds the people who may hold it now:
 * `tasks.eligibleAssignees`, and with `committed_follow_up` only those who may own a follow-up. A person already on the
 * record who is no longer eligible stays in the list with their warning, so they can be removed. The picker stops at
 * ten and says so. `onOpenChange` lets a screen that saves at once commit when the list closes.
 */
export function AssigneePicker({
	value,
	onChange,
	purpose,
	held = [],
	viewerId,
	label = "Search people",
	placeholder = "No one yet",
	id,
	onOpenChange,
	className,
}: {
	value: string[];
	/** The new selection, with the name of every account in it, so a screen can show it before the server answers. */
	onChange: (ids: string[], names: Record<string, string>) => void;
	purpose: Purpose;
	held?: readonly Held[];
	viewerId?: string;
	label?: string;
	placeholder?: string;
	id?: string;
	onOpenChange?: (open: boolean) => void;
	className?: string;
}) {
	const [loaded, setLoaded] = useState<{
		purpose: Purpose;
		options: { accountId: string; displayName: string }[] | "failed";
	} | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let live = true;
		void warmAssignees(purpose).then((r) => {
			if (!live) return;
			setLoaded({ purpose, options: r.status === "ok" ? r.value.items : "failed" });
		});
		return () => void (live = false);
	}, [purpose, attempt]);
	const people = loaded?.purpose === purpose && Array.isArray(loaded.options) ? loaded.options : null;
	const failed = loaded?.purpose === purpose && loaded.options === "failed";
	const you = (accountId: string, name: string) => (accountId === viewerId ? `${name} (you)` : name);
	const eligible = new Set((people ?? []).map((p) => p.accountId));
	// Until the list arrives, the choice shows the names the record already has, so the field never looks empty.
	const names = new Map<string, string>();
	const options = [
		...(people ?? held.filter((h) => !h.warning)).map((p) => {
			const name = p.displayName.trim() || "Unnamed member";
			names.set(p.accountId, name);
			return { value: p.accountId, label: you(p.accountId, name) };
		}),
		...held
			.filter((h) => (people ? !eligible.has(h.accountId) : Boolean(h.warning)))
			.map((h) => {
				const name = h.displayName.trim() || "A former member";
				names.set(h.accountId, name);
				return { value: h.accountId, label: `${name} · ${h.warning ?? "no longer has a seat"}` };
			}),
	];
	const atLimit = value.length >= MAX_ASSIGNEES;
	const shown = options.map((o) => ({ ...o, disabled: atLimit && !value.includes(o.value) }));
	return (
		<div className="flex flex-col gap-1.5" onPointerOver={() => void warmAssignees(purpose)}>
			<Combobox
				id={id}
				multiple
				className={className}
				options={shown}
				value={value}
				placeholder={placeholder}
				searchLabel={label}
				loading={!people && !failed && options.length === 0}
				error={
					failed
						? {
								message: "The list of people did not load.",
								onRetry: () => {
									forgetAssignees();
									setLoaded(null);
									setAttempt((n) => n + 1);
								},
							}
						: undefined
				}
				emptyText={purpose === "committed_follow_up" ? "No one can own follow-ups yet" : "No matches"}
				onOpenChange={onOpenChange}
				onValueChange={(ids) =>
					onChange(ids, Object.fromEntries(ids.map((accountId) => [accountId, names.get(accountId) ?? ""])))
				}
			/>
			{atLimit ? (
				<p role="status" className="text-xs text-text-2">
					Up to {MAX_ASSIGNEES} people. Remove someone to add another.
				</p>
			) : null}
		</div>
	);
}
