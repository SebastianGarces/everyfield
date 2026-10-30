"use client";

import {
	Alert02Icon,
	Building03Icon,
	ChurchIcon,
	PaintBrush01Icon,
	Notification01Icon,
	ShieldUserIcon,
	UserIcon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { Button, ConfirmDialog, Dialog, DialogContent, DialogHeader, StatePanel } from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { cn, Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import { createContext, use, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { offeredSections, SECTION_LABEL } from "./model";
import type { SectionKey } from "./port";
import { useDirtySections, useSettings } from "./store";
import { AccountSection } from "./sections/AccountSection";
import { BrandSection } from "./brand/BrandSection";
import { ChurchSection } from "./sections/ChurchSection";
import { NotificationsSection } from "./sections/NotificationsSection";
import { OrganizationSection } from "./sections/OrganizationSection";
import type { DeletionStatus } from "./port";

const ICON: Record<SectionKey, IconSvgElement> = {
	church: ChurchIcon,
	brand: PaintBrush01Icon,
	organization: Building03Icon,
	seats: UserMultipleIcon,
	notifications: Notification01Icon,
	sharing: ShieldUserIcon,
	account: UserIcon,
};

const DESCRIPTION: Record<SectionKey, string> = {
	church: "Used in emails, documents and Plant Intelligence.",
	brand: "Colors, fonts and letterhead for the documents and emails Everyfield makes for your church.",
	organization: "How your organization appears to the churches you work with.",
	seats: "People who can sign in to your church.",
	notifications: "Your choices only. Other seats set their own.",
	sharing: "Choose what connected organizations can see. Names and personal details are never shared.",
	account: "Only you can change these.",
};

type Frame = { requestClose: () => void };
const FrameContext = createContext<Frame | null>(null);

export type SettingsDialogProps = {
	/** The section in the URL, or null when settings is closed. */
	section: SectionKey | null;
	/** Changes the URL: a section, or null to close and return to the page underneath. */
	onNavigate: (section: SectionKey | null) => void;
	/** The link for a section, so each one can be opened in a new tab or shared. */
	hrefFor: (section: SectionKey) => string;
	/** Sections drawn by their caller inside this frame, such as Seats (WP-008/ui) and Sharing (WP-007). */
	slots?: Partial<Record<SectionKey, ReactNode>>;
	/** A deletion was requested: the session ends and the restricted status page takes over. */
	onDeletionRequested: (status: DeletionStatus | null) => void;
};

/**
 * SettingsDialog (<SettingsDialog section>): side nav, one section, and a footer for sections with a Save button.
 * Every section has its own URL. Drafts stay while you move between sections; closing with unsaved changes asks
 * before discarding them, also when Back leaves settings (REQ-IDN-010).
 */
export function SettingsDialog({ section, onNavigate, hrefFor, slots = {}, onDeletionRequested }: SettingsDialogProps) {
	const { viewer } = useSettings();
	const dirty = useDirtySections();
	const offered = offeredSections(viewer, Object.keys(slots) as SectionKey[]);
	const [shown, setShown] = useState<SectionKey | null>(section);
	const [confirming, setConfirming] = useState(false);
	const panel = useRef<HTMLDivElement>(null);
	const navLabel = useId();

	// The URL leads. When it closes settings while drafts are unsaved (Back, or a link), keep the last section on
	// screen and ask; Keep editing puts its URL back. Only a URL change decides this, during render (React's
	// "adjust state when a prop changes" pattern), so drafts changing alone never close settings.
	const [urlSection, setUrlSection] = useState(section);
	if (section !== urlSection) {
		setUrlSection(section);
		if (section) setShown(section);
		else if (dirty.keys.length > 0 && shown) setConfirming(true);
		else setShown(null);
	}

	// When a section change removes the focused control (Back or Forward), focus moves to the current nav link
	// instead of falling to the page body.
	useEffect(() => {
		if (!shown) return;
		const frame = requestAnimationFrame(() => {
			const root = panel.current;
			if (!root || root.contains(document.activeElement)) return;
			if (document.querySelector("[role=alertdialog]")) return;
			root.querySelector<HTMLElement>("[data-settings-nav][aria-current=page]")?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [shown]);

	const requestClose = () => {
		if (dirty.keys.length > 0) setConfirming(true);
		else {
			setShown(null);
			onNavigate(null);
		}
	};
	// ConfirmDialog also reports "closed" after Discard runs, so Discard marks itself first.
	const discarded = useRef(false);
	const keepEditing = (open: boolean) => {
		if (open) return;
		setConfirming(false);
		if (discarded.current) {
			discarded.current = false;
			return;
		}
		if (!section && shown) onNavigate(shown);
	};
	const discard = () => {
		discarded.current = true;
		dirty.clear();
		setConfirming(false);
		setShown(null);
		if (section) onNavigate(null);
	};

	const go = (key: SectionKey) => (e: MouseEvent<HTMLAnchorElement>) => {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
		e.preventDefault();
		if (key !== shown) onNavigate(key);
	};

	const current = shown;
	const allowed = current !== null && offered.includes(current);
	const unsavedNames = dirty.keys.map((k) => SECTION_LABEL[k]);

	return (
		<FrameContext value={{ requestClose }}>
			<Dialog open={current !== null} onOpenChange={(open) => (open ? undefined : requestClose())}>
				<DialogContent
					size="lg"
					aria-describedby={undefined}
					onOpenAutoFocus={(e) => {
						// Start on the current section's link, so Tab then walks into that section.
						const link = panel.current?.querySelector<HTMLElement>("[data-settings-nav][aria-current=page]");
						if (!link) return;
						e.preventDefault();
						link.focus();
					}}
					className="h-[min(720px,calc(100dvh-24px))] max-w-[1040px]! overflow-hidden bg-surface!"
				>
					<div
						ref={panel}
						className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] max-app-md:grid-cols-[200px_minmax(0,1fr)] max-app-sm:flex max-app-sm:flex-col"
					>
						<nav
							aria-labelledby={navLabel}
							className="flex flex-col gap-0.5 border-r border-line bg-frame px-3.5 py-[22px] max-app-sm:border-r-0 max-app-sm:border-b max-app-sm:px-3 max-app-sm:py-3"
						>
							<p
								id={navLabel}
								className="px-3 pt-1 pb-3.5 font-title tracking-[-0.02em] text-[22px] max-app-sm:sr-only"
							>
								Settings
							</p>
							<ul className="flex flex-col gap-0.5 max-app-sm:flex-row max-app-sm:flex-wrap max-app-sm:gap-1.5">
								{offered.map((key) => {
									const isCurrent = key === current;
									const unsaved = dirty.keys.includes(key);
									return (
										<li key={key}>
											<a
												href={hrefFor(key)}
												onClick={go(key)}
												data-settings-nav={key}
												aria-current={isCurrent ? "page" : undefined}
												className={cn(
													"flex h-[42px] items-center gap-2.5 rounded-sm px-3 font-medium transition-[background-color,box-shadow,color] duration-150 max-app-sm:h-9 max-app-sm:px-3 max-app-sm:text-sm",
													isCurrent ? "bg-surface-raised text-ink shadow-raised" : "text-ink-2 hover:bg-hover",
												)}
											>
												<Icon
													icon={ICON[key]}
													size={18}
													className={cn(isCurrent ? "text-ink" : "text-text-3", "max-app-sm:hidden")}
												/>
												<span className="min-w-0 flex-1 truncate">{SECTION_LABEL[key]}</span>
												{unsaved ? (
													<span className="size-2 flex-none rounded-full bg-amber-500">
														<span className="sr-only">, unsaved changes</span>
													</span>
												) : null}
											</a>
										</li>
									);
								})}
							</ul>
							<span className="flex-1" />
							<p className="px-3 text-xs text-text-3 max-app-sm:hidden">
								Each section has its own link, so you can share it.
							</p>
						</nav>
						<div className="flex min-h-0 min-w-0 flex-1 flex-col">
							<DialogHeader
								title={
									// The prototype's section title is 26px (the dialog header default is smaller).
									<span className="font-display text-[26px] leading-[1.15] tracking-[-0.02em]">
										{current ? SECTION_LABEL[current] : "Settings"}
									</span>
								}
								description={allowed && current ? DESCRIPTION[current] : undefined}
							/>
							{current === null ? null : allowed ? (
								<SectionContent
									key={current}
									section={current}
									slots={slots}
									onDeletionRequested={onDeletionRequested}
								/>
							) : (
								<SectionBody>
									<StatePanel tone="lock" title={`${SECTION_LABEL[current]} is not available to you`} headingLevel="h3">
										{current === "church" || current === "organization"
											? "Only an Owner or Admin can change this profile. Ask one of them, or open your own settings."
											: current === "brand"
												? "Only an Owner or Admin of a church can change its brand kit. Ask one of them, or open your own settings."
												: "This section is not part of your settings."}
									</StatePanel>
								</SectionBody>
							)}
						</div>
					</div>
				</DialogContent>
			</Dialog>
			<ConfirmDialog
				open={confirming}
				onOpenChange={keepEditing}
				title="Discard unsaved changes?"
				description={`You changed ${listNames(unsavedNames)}. Closing settings discards these changes.`}
				cancelLabel="Keep editing"
				confirmLabel="Discard changes"
				tone="danger"
				onConfirm={discard}
			/>
		</FrameContext>
	);
}

function listNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? "this section";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function SectionContent({
	section,
	slots,
	onDeletionRequested,
}: {
	section: SectionKey;
	slots: Partial<Record<SectionKey, ReactNode>>;
	onDeletionRequested: (status: DeletionStatus | null) => void;
}) {
	switch (section) {
		case "church":
			return <ChurchSection onDeletionRequested={onDeletionRequested} />;
		case "brand":
			return <BrandSection />;
		case "organization":
			return <OrganizationSection />;
		case "notifications":
			return <NotificationsSection />;
		case "account":
			return <AccountSection onDeletionRequested={onDeletionRequested} />;
		case "seats":
		case "sharing":
			return <>{slots[section]}</>;
	}
}

/**
 * The scrolling body of a section. It is a focusable region, so keyboard users can scroll it even when it holds no
 * control (a Member's read-only Sharing on a phone).
 */
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

/**
 * One setting: label and description on the left, the control on the right (prototype .set-row). `htmlFor` links
 * the label to a single control; without it the controls form a group named by the label.
 */
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

/** A refusal in words, with the support reference and an optional next step. */
export function SaveError({ message, reference, action }: { message: string; reference?: string; action?: ReactNode }) {
	return (
		<div
			role="alert"
			className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600"
		>
			<Icon icon={Alert02Icon} size={16} />
			<span className="min-w-0 flex-1">
				{message}
				{reference ? <span className="text-text-2"> Reference {reference}.</span> : null}
			</span>
			{action}
		</div>
	);
}

/**
 * The footer of a section with a Save button (prototype .modal-foot). It says when the section has unsaved changes
 * and names other sections that still have some. Cancel closes settings and asks first when anything is unsaved.
 */
export function SaveFooter({
	section,
	dirty,
	saving,
	onSave,
	error,
}: {
	section: SectionKey;
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
					Save
				</Button>
			</div>
		</div>
	);
}

/** The footer of a section whose switches save at once. */
export function AutoSaveFooter() {
	return (
		<div className="flex-none border-t border-line bg-surface px-8 py-4 text-sm text-text-3 max-app-sm:px-5">
			Changes here save as you make them.
		</div>
	);
}
