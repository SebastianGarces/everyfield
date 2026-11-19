"use client";

import { Alert02Icon, Cancel01Icon, InformationCircleIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { CSSProperties, ReactNode } from "react";
import { Toaster as Sonner, toast as sonner } from "sonner";
import { cn, Icon } from "../foundations";

export type ToastTone = "success" | "info" | "error";

export type ToastInput = {
	message: ReactNode;
	tone?: ToastTone;
	action?: { label: string; onSelect: () => void };
	duration?: number;
};

const ICON = { success: Tick02Icon, info: InformationCircleIcon, error: Alert02Icon } as const;
const ICON_TONE = { success: "text-green-300", info: "text-blue-300", error: "text-magenta-300" } as const;

export function toast({ message, tone = "success", action, duration }: ToastInput): void {
	sonner.custom((id) => <ToastCard id={id} message={message} tone={tone} action={action} />, {
		duration: duration ?? (tone === "error" ? Infinity : 5000),
	});
}

type CardProps = { id: string | number; message: ReactNode; tone: ToastTone; action?: ToastInput["action"] };

function ToastCard({ id, message, tone, action }: CardProps) {
	return (
		<div className="flex w-full items-center gap-3 rounded-card bg-ink py-3 font-sans pr-3 pl-4 text-md text-on-ink shadow-pop">
			<span
				aria-hidden="true"
				className={cn("grid size-7 flex-none place-items-center rounded-pill bg-on-ink-soft", ICON_TONE[tone])}
			>
				<Icon icon={ICON[tone]} size={16} />
			</span>
			<div className="min-w-0 flex-1">{message}</div>
			{action ? (
				<button
					type="button"
					onClick={() => {
						action.onSelect();
						sonner.dismiss(id);
					}}
					className="h-8 flex-none rounded-sm bg-on-ink-soft px-2.5 text-sm font-medium text-on-ink transition-[background-color] hover:bg-[color-mix(in_srgb,var(--ef-on-ink)_20%,transparent)]"
				>
					{action.label}
				</button>
			) : null}
			<button
				type="button"
				aria-label="Close"
				onClick={() => sonner.dismiss(id)}
				className="grid size-8 flex-none place-items-center rounded-sm text-on-ink opacity-80 transition-[opacity,background-color] hover:bg-on-ink-soft hover:opacity-100"
			>
				<Icon icon={Cancel01Icon} size={16} />
			</button>
		</div>
	);
}

const WIDTH = { "--width": "440px" } as CSSProperties;

export function Toaster() {
	return (
		<Sonner
			position="bottom-center"
			gap={10}
			offset={24}
			mobileOffset={12}
			style={WIDTH}
			className="ef-toaster"
			containerAriaLabel="Notifications"
		/>
	);
}
