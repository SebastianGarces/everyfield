"use client";

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Switch } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useId, useState } from "react";
import { setChurchBranding } from "./actions.ts";

// The "Use church branding" switch of one Church Document. The switch moves at once and the write confirms it; a
// refusal or a lost reply puts it back at the stored value with a message, so it never shows a value that was not saved.
// Changing it makes no revision: only later previews and exports follow it.

const LOST =
	"The connection dropped, so the change may not have been saved. Reload the page to see the current setting.";

export function ChurchBranding({
	documentId,
	stored,
	onSaved,
	access,
	className,
}: {
	documentId: string;
	/** The stored value. */
	stored: boolean;
	onSaved: (useChurchBranding: boolean) => void;
	/** "member" reads the value only. "no-kit" can change it, but the church has no brand kit to paint yet. */
	access: "kit" | "no-kit" | "member";
	className?: string;
}) {
	const [pending, setPending] = useState<boolean | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const describedBy = useId();
	const shown = pending ?? stored;

	async function change(next: boolean) {
		// One write at a time. The switch stays enabled while it saves, so keyboard focus stays on it.
		if (pending !== null) return;
		setPending(next);
		setProblem(null);
		try {
			const result = await setChurchBranding(documentId, next);
			if (result.status === "saved") onSaved(result.useChurchBranding);
			else setProblem(result.status === "refused" ? `Church branding was not changed. ${result.message}` : LOST);
		} catch {
			setProblem(LOST);
		} finally {
			setPending(null);
		}
	}

	return (
		<section
			aria-label="Branding"
			className={`mb-4 rounded-card bg-surface-raised px-4 py-2 shadow-[0_0_0_1px_var(--ef-line)] ${className ?? ""}`}
		>
			<Switch
				label="Use church branding"
				checked={shown}
				disabled={access === "member"}
				aria-busy={pending !== null}
				aria-describedby={describedBy}
				onCheckedChange={(next) => void change(next)}
				description={
					<span id={describedBy} className="flex flex-col gap-1">
						{access === "no-kit" ? null : <span aria-live="polite">{describe(shown, access === "member")}</span>}
						{access === "no-kit" ? (
							<span>
								Your church has no brand kit yet, so documents use the plain Everyfield look.{" "}
								<Link href="/settings/brand" className="cursor-pointer font-medium text-ink underline">
									Set up the brand kit
								</Link>
							</span>
						) : null}
						{access === "member" ? <span>Only an Owner or Admin can change this.</span> : null}
					</span>
				}
			/>
			<div aria-live="assertive" className="empty:hidden">
				{problem ? (
					<p className="mb-2 flex items-start gap-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600">
						<Icon icon={Alert02Icon} size={16} className="mt-0.5 flex-none" />
						<span className="min-w-0 flex-1">{problem}</span>
					</p>
				) : null}
			</div>
		</section>
	);
}

function describe(on: boolean, member: boolean) {
	if (!on) return "Previews and new downloads use the plain Everyfield look.";
	return member
		? "Previews and downloads use the church's brand kit when it has one."
		: "Previews and new downloads use your church's logo and colors.";
}
