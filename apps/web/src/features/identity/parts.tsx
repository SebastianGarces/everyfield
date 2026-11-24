"use client";

import { LockKeyIcon, ViewIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons";
import { Alert, CardIcon, FieldButton, Input, type Tone } from "@everyfield/ui/controls";
import type { IconSvgElement } from "@everyfield/ui/foundations";
import { useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { AuthHeading } from "./AuthFrame";

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
				<FieldButton
					icon={shown ? ViewOffSlashIcon : ViewIcon}
					label="Show password"
					pressed={shown}
					onClick={() => setShown((v) => !v)}
				/>
			}
		/>
	);
}

export function FormMessage({ tone, children }: { tone: "error" | "success" | "neutral"; children: ReactNode }) {
	return (
		<div role={tone === "error" ? "alert" : "status"} className="empty:sr-only">
			{children ? <Alert tone={tone}>{children}</Alert> : null}
		</div>
	);
}

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
