"use client";

import { Button } from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { cn } from "@everyfield/ui/foundations";
import { createContext, use, useId, type ReactNode } from "react";
import { SECTION_LABEL } from "./model";
import type { SectionKey } from "./port";
import { useDirtySections } from "./store";

type Frame = { requestClose: () => void };
export const FrameContext = createContext<Frame | null>(null);

export function listNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? "this section";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function SectionBody({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			role="region"
			aria-label="Section content"
			tabIndex={0}
			data-focus-inset=""
			className={cn("min-h-0 flex-1 overflow-y-auto px-8 pt-2 pb-8 max-app-sm:px-5", className)}
		>
			{children}
		</div>
	);
}

export function SettingRow({
	label,
	description,
	htmlFor,
	aside,
	children,
}: {
	label: string;
	description?: ReactNode;
	htmlFor?: string;
	aside?: ReactNode;
	children: ReactNode;
}) {
	const id = useId();
	const LabelTag = htmlFor ? "label" : "p";
	return (
		<div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-6 border-t border-line py-[18px] first:border-t-0 max-app-md:grid-cols-1 max-app-md:gap-3">
			<div>
				<LabelTag id={`${id}-label`} htmlFor={htmlFor} className="block font-medium text-ink">
					{label}
				</LabelTag>
				{description ? (
					<p id={`${id}-desc`} className="mt-1 text-sm leading-[1.45] text-text-3">
						{description}
					</p>
				) : null}
				{aside}
			</div>
			{htmlFor ? (
				<div className="min-w-0">{children}</div>
			) : (
				<div
					role="group"
					aria-labelledby={`${id}-label`}
					aria-describedby={description ? `${id}-desc` : undefined}
					className="min-w-0"
				>
					{children}
				</div>
			)}
		</div>
	);
}

export function SaveFooter({
	section,
	dirty,
	saving,
	onSave,
	error,
	label = "Save",
}: {
	section: SectionKey;
	label?: string;
	dirty: boolean;
	saving: boolean;
	onSave: () => void;
	error?: ReactNode;
}) {
	const frame = use(FrameContext);
	const others = useDirtySections().keys.filter((k) => k !== section);
	return (
		<div className="flex-none border-t border-line bg-surface">
			{error ? <div className="px-8 pt-3 max-app-sm:px-5">{error}</div> : null}
			<div className="flex flex-wrap items-center gap-2.5 py-3.5 pr-5 pl-8 max-app-sm:px-5">
				<div aria-live="polite" className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
					{dirty ? (
						<>
							<StatusBadge status="attention" size="sm">
								Unsaved changes
							</StatusBadge>
							<span className="text-sm text-text-3">Closing asks before discarding.</span>
						</>
					) : (
						<span className="text-sm text-text-3">
							{others.length > 0
								? `${listNames(others.map((k) => SECTION_LABEL[k]))} ${others.length === 1 ? "has" : "have"} unsaved changes.`
								: "No unsaved changes."}
						</span>
					)}
				</div>
				<Button variant="ghost" onClick={frame?.requestClose}>
					Cancel
				</Button>
				<Button variant="primary" onClick={onSave} loading={saving} disabled={!dirty && !saving}>
					{label}
				</Button>
			</div>
		</div>
	);
}

export function AutoSaveFooter() {
	return (
		<div className="flex-none border-t border-line bg-surface px-8 py-4 text-sm text-text-3 max-app-sm:px-5">
			Changes here save as you make them.
		</div>
	);
}
