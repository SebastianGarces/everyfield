"use client";

import {
	Alert02Icon,
	CheckmarkCircle02Icon,
	LockKeyIcon,
	ViewIcon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { CardIcon, Input, type Tone } from "@everyfield/ui/controls";
import { cn, Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import { useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { AuthHeading } from "./AuthFrame";

/** A password Input with a Show/Hide button. The button keeps its own name, so the field label stays "Password". */
export function PasswordInput(props: Omit<ComponentPropsWithRef<typeof Input>, "type" | "icon" | "trailing">) {
	const [shown, setShown] = useState(false);
	return (
		<Input
			{...props}
			type={shown ? "text" : "password"}
			icon={LockKeyIcon}
			spellCheck={false}
			autoCapitalize="none"
			trailing={
				<button
					type="button"
					aria-pressed={shown}
					onClick={() => setShown((v) => !v)}
					className="-mr-2 grid size-9 flex-none cursor-pointer place-items-center rounded-sm text-text-2 transition-[background-color] duration-150 hover:bg-hover hover:text-ink"
				>
					<Icon icon={shown ? ViewOffSlashIcon : ViewIcon} size={18} />
					<span className="sr-only">Show password</span>
				</button>
			}
		/>
	);
}

/**
 * The form-level message above a submit button. A refusal is an alert, so a screen reader hears it when it appears;
 * a confirmation is a polite status. The region stays mounted and empty until there is something to say.
 */
export function FormMessage({ tone, children }: { tone: "error" | "success"; children: ReactNode }) {
	return (
		<div role={tone === "error" ? "alert" : "status"} className="empty:hidden">
			{children ? (
				<p
					className={cn(
						"flex items-start gap-2.5 rounded-md px-3.5 py-3 text-sm font-medium",
						tone === "error" ? "bg-magenta-100 text-magenta-600" : "bg-green-100 text-green-700",
					)}
				>
					<Icon icon={tone === "error" ? Alert02Icon : CheckmarkCircle02Icon} size={18} className="mt-px flex-none" />
					<span>{children}</span>
				</p>
			) : null}
		</div>
	);
}

/** A finished step: an icon tile, the heading, its explanation and the next actions. */
export function Outcome({
	icon,
	tone,
	title,
	children,
	actions,
}: {
	icon: IconSvgElement;
	tone: Tone;
	title: string;
	children: ReactNode;
	actions: ReactNode;
}) {
	return (
		<>
			<CardIcon icon={icon} tone={tone} className="mb-6" />
			<AuthHeading title={title}>{children}</AuthHeading>
			<div className="mt-6 flex flex-col gap-3">{actions}</div>
		</>
	);
}
