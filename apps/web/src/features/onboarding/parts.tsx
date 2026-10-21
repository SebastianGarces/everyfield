"use client";

import { ArrowLeft01Icon, ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@everyfield/ui/controls";
import { cn, EvryBot, Icon, LogoMark, Wordmark } from "@everyfield/ui/foundations";
import { useEffect, useRef, type ReactNode } from "react";
import { STEPS, type ErrorCode, type StepKey } from "./model";

// Shared pieces of the onboarding page, composed from @everyfield/ui and the prototype's .onb, .onb-steps and
// .phase-pick layout (design/everyfield-ui.html, #/onboarding).

export function OnboardingFrame({
	steps,
	aside,
	children,
}: {
	steps?: ReactNode;
	aside?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex min-h-dvh flex-col">
			<header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 px-4 py-4 sm:px-8 sm:py-6">
				<span className="flex items-center gap-3 text-ink" aria-label="Everyfield" role="img">
					<LogoMark className="w-7" />
					<Wordmark className="h-5" />
				</span>
				{steps ? <div className="order-3 w-full sm:order-none sm:w-auto">{steps}</div> : null}
				{aside ?? <span />}
			</header>
			<main className="flex-1 px-4 pt-4 pb-16 sm:px-8 sm:pt-[30px] sm:pb-[60px]">{children}</main>
		</div>
	);
}

/**
 * The step pills. Before the church exists they only show progress. After, each is a button: basics show read-only,
 * so moving back never reruns creation. The current step has aria-current="step".
 */
export function StepPills({
	current,
	done,
	onGo,
}: {
	current: StepKey;
	done: (key: StepKey) => boolean;
	onGo?: (key: StepKey) => void;
}) {
	return (
		<nav aria-label="Setup steps">
			<ol className="flex gap-1.5 rounded-full bg-surface-raised p-[5px] shadow-nav">
				{STEPS.map((step, index) => {
					const state = step.key === current ? "current" : done(step.key) ? "done" : "todo";
					const inner = (
						<>
							<span
								aria-hidden="true"
								className={cn(
									"grid size-6 flex-none place-items-center rounded-full text-xs font-semibold",
									state === "current" && "bg-on-ink-soft text-on-ink",
									state === "done" && "bg-green-100 text-green-700",
									state === "todo" && "bg-surface-2",
								)}
							>
								{state === "done" ? <Icon icon={Tick02Icon} size={16} /> : index + 1}
							</span>
							<span className={cn(state === "current" ? "inline" : "sr-only md:not-sr-only")}>{step.label}</span>
							{state === "done" ? <span className="sr-only"> (done)</span> : null}
						</>
					);
					const pill = cn(
						"inline-flex h-9 items-center gap-2 rounded-full pr-3.5 pl-1.5 text-sm font-medium whitespace-nowrap max-md:pr-1.5",
						state === "current" ? "bg-ink text-on-ink max-md:pr-3.5" : state === "done" ? "text-text-2" : "text-text-3",
					);
					return (
						<li key={step.key}>
							{onGo ? (
								<button
									type="button"
									className={cn(
										pill,
										"cursor-pointer transition-[background-color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
										state !== "current" && "hover:bg-hover",
									)}
									aria-current={state === "current" ? "step" : undefined}
									onClick={() => onGo(step.key)}
								>
									{inner}
								</button>
							) : (
								<span className={pill} aria-current={state === "current" ? "step" : undefined}>
									{inner}
								</span>
							)}
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

/** The centered step heading with Evry. Focus moves to the heading when the step changes, so screen readers hear it. */
export function StepHeading({
	title,
	children,
	mood = "idle",
}: {
	title: string;
	children?: ReactNode;
	mood?: "idle" | "happy";
}) {
	const ref = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		if (document.activeElement === document.body || document.activeElement?.closest("[data-onboarding-step]"))
			ref.current?.focus({ preventScroll: false });
	}, [title]);
	return (
		<div className="mx-auto max-w-[620px] text-center">
			<EvryBot size="lg" mood={mood === "happy" ? "happy" : "idle"} />
			<h1
				ref={ref}
				tabIndex={-1}
				className="mt-[18px] text-[32px] leading-[1.1] text-balance text-ink outline-none sm:text-[44px]"
			>
				{title}
			</h1>
			{children ? <p className="mt-3 text-base text-pretty text-text-2">{children}</p> : null}
		</div>
	);
}

/** A choice card: a native radio inside its label, so arrow keys move within the group and the whole card is the target. */
export function ChoiceCard({
	name,
	value,
	checked,
	onChange,
	badge,
	title,
	detail,
	className,
	disabled,
}: {
	name: string;
	value: string;
	checked: boolean;
	onChange: (value: string) => void;
	badge?: ReactNode;
	title: ReactNode;
	detail?: ReactNode;
	className?: string;
	disabled?: boolean;
}) {
	return (
		<label
			className={cn(
				"relative flex cursor-pointer items-center gap-3.5 rounded-[18px] border border-line bg-surface-raised px-[18px] py-4 shadow-card transition-[box-shadow] duration-150",
				"has-[:checked]:shadow-[0_0_0_2px_var(--ef-ink),var(--ef-shadow-card)]",
				"has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
				"has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
				className,
			)}
		>
			<input
				type="radio"
				name={name}
				value={value}
				checked={checked}
				disabled={disabled}
				onChange={() => onChange(value)}
				className="peer sr-only"
			/>
			{badge !== undefined ? (
				<span
					aria-hidden="true"
					className="grid size-[34px] flex-none place-items-center rounded-[11px] bg-surface-2 font-title tracking-[-0.02em] text-ink peer-checked:bg-ink peer-checked:text-on-ink"
				>
					{badge}
				</span>
			) : null}
			<span className="flex min-w-0 flex-1 flex-col gap-[3px]">
				<b className="font-semibold text-ink">{title}</b>
				{detail ? <span className="text-sm text-text-3">{detail}</span> : null}
			</span>
			<span aria-hidden="true" className="hidden text-ink peer-checked:block">
				<Icon icon={Tick02Icon} size={18} />
			</span>
		</label>
	);
}

/** Back on the left; Skip and Continue on the right (prototype footer row). */
export function StepFooter({
	onBack,
	onSkip,
	skipLabel = "Skip for now",
	continueLabel = "Continue",
	busy,
	onContinue,
	continueType = "button",
}: {
	onBack?: () => void;
	onSkip?: () => void;
	skipLabel?: string;
	continueLabel?: string;
	busy?: boolean;
	onContinue?: () => void;
	continueType?: "button" | "submit";
}) {
	return (
		<div className="mx-auto mt-[30px] flex max-w-[820px] flex-wrap items-center justify-between gap-3">
			{onBack ? (
				<Button variant="ghost" icon={ArrowLeft01Icon} onClick={onBack}>
					Back
				</Button>
			) : (
				<span />
			)}
			<div className="ml-auto flex flex-wrap items-center justify-end gap-2">
				{onSkip ? (
					<Button variant="ghost" onClick={onSkip} aria-disabled={busy || undefined}>
						{skipLabel}
					</Button>
				) : null}
				<Button variant="primary" type={continueType} loading={busy} onClick={onContinue}>
					{continueLabel}
					<Icon icon={ArrowRight01Icon} size={18} />
				</Button>
			</div>
		</div>
	);
}

/** One sentence per refusal code, saying what happened and what to do. */
export function noticeText(code: ErrorCode): string {
	switch (code) {
		case "conflict":
			return "Something changed while you were on this step. We loaded the latest. Check it, then continue.";
		case "already_declared":
			return "A phase is already declared for this church. We loaded it.";
		case "active_seat_conflict":
			return "This account already belongs to a church, so it can’t start another one.";
		case "association_resolution_required":
			return "This account has a Discovery space. Start your church from there.";
		case "idempotency_conflict":
			return "That save could not be matched to your last try. Try again.";
		case "temporary":
			return "We couldn’t save just now. Try again in a moment.";
		case "unknown":
			return "We’re not sure that saved. We loaded the latest. Check it before you continue.";
		case "invalid_input":
			return "Some answers could not be saved. Check them and try again.";
		default:
			return "This step isn’t available to this account right now. Reload the page to see where things stand.";
	}
}

export function Notice({ code }: { code: ErrorCode | null }) {
	return (
		<div aria-live="polite" className="mx-auto max-w-[820px]">
			{code ? (
				<p role="alert" className="mt-6 rounded-md bg-magenta-50 px-4 py-3 text-sm font-medium text-magenta-600">
					{noticeText(code)}
				</p>
			) : null}
		</div>
	);
}

/** A read-only summary card for an answer that cannot change here. */
export function SavedCard({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<div className="mx-auto mt-[34px] max-w-[820px] rounded-[18px] border border-line bg-surface-raised px-6 py-5 shadow-card">
			<div className="flex items-start gap-3.5">
				<span
					className="grid size-[34px] flex-none place-items-center rounded-[11px] bg-green-100 text-green-700"
					aria-hidden="true"
				>
					<Icon icon={Tick02Icon} size={18} />
				</span>
				<div className="min-w-0">
					<h2 className="font-sans text-md font-semibold tracking-normal text-ink">{title}</h2>
					{children ? <div className="mt-1 text-sm text-text-2">{children}</div> : null}
				</div>
			</div>
		</div>
	);
}
