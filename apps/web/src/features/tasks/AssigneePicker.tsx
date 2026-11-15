"use client";

import { MAX_ASSIGNEES } from "@everyfield/contracts/tasks";
import { Combobox } from "@everyfield/ui/controls";
import { createRead, useRead } from "../../components/read.tsx";
import { assigneeOptions } from "./fetch.ts";
import { assigneeName } from "./model.ts";

type Purpose = "any" | "committed_follow_up";
/** An account already on the record, with the warning it earns when it is no longer an eligible choice. */
export type Held = { accountId: string; displayName: string; warning?: string | null };

// The church's seats change rarely, so one read serves every picker on this page; a failed read is forgotten, so the
// next use tries again. Intent on a button that opens a picker starts it, so the list is there when it opens.
const seats = createRead((purpose: Purpose) => assigneeOptions(purpose), {
	failed: () => ({ status: "lost" }) as const,
	fresh: Infinity,
});
export const warmAssignees = (purpose: Purpose = "any") => seats.get(purpose);
/** After a refusal that names an account as ineligible, the next read asks again. */
export const forgetAssignees = () => seats.forget();

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
	onOpenChange?: (open: boolean) => void;
	className?: string;
}) {
	const read = useRead(seats, purpose);
	const people: { accountId: string; displayName: string }[] | null =
		read.value?.status === "ok" ? read.value.value.items : null;
	const failed = read.value !== undefined && read.value.status !== "ok";
	const you = (accountId: string, name: string) => (accountId === viewerId ? `${name} (you)` : name);
	const eligible = new Set((people ?? []).map((p) => p.accountId));
	// Until the list arrives, the choice shows the names the record already has, so the field never looks empty.
	const names = new Map<string, string>();
	const options = [
		...(people ?? held.filter((h) => !h.warning)).map((p) => {
			const name = assigneeName(p);
			names.set(p.accountId, name);
			return { value: p.accountId, label: you(p.accountId, name) };
		}),
		...held
			.filter((h) => (people ? !eligible.has(h.accountId) : Boolean(h.warning)))
			.map((h) => {
				const name = assigneeName(h);
				names.set(h.accountId, name);
				const warning =
					h.warning ?? (purpose === "committed_follow_up" ? "Can't own follow-ups now" : "no longer has a seat");
				return { value: h.accountId, label: `${name} · ${warning}` };
			}),
	];
	const atLimit = value.length >= MAX_ASSIGNEES;
	const shown = options.map((o) => ({ ...o, disabled: atLimit && !value.includes(o.value) }));
	return (
		<div className="flex flex-col gap-1.5" onPointerOver={() => void warmAssignees(purpose)}>
			<Combobox
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
								onRetry: read.retry,
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
