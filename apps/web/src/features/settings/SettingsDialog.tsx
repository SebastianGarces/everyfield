"use client";

import {
	BookOpen01Icon,
	Building03Icon,
	ChurchIcon,
	PaintBrush01Icon,
	Notification01Icon,
	ShieldUserIcon,
	UserIcon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { ConfirmDialog, Dialog, DialogContent, DialogHeader, StatePanel } from "@everyfield/ui/controls";
import { cn, Icon, useFocusRequest, type IconSvgElement } from "@everyfield/ui/foundations";
import { useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { unsavedMark } from "../../components/save/leave.ts";
import { offeredSections, SECTION_LABEL } from "./model";
import type { SectionKey } from "./port";
import { FrameContext, listNames, SectionBody } from "./SectionParts";
import { useDirtySections, useSettings } from "./store";
import { AccountSection } from "./sections/AccountSection";
import { BrandSection } from "./brand/BrandSection";
import { ChurchSection } from "./sections/ChurchSection";
import { NotificationsSection } from "./sections/NotificationsSection";
import { OrganizationSection } from "./sections/OrganizationSection";
import { WikiSourcesSection } from "./sections/WikiSourcesSection";
import type { DeletionStatus } from "./port";

const ICON: Record<SectionKey, IconSvgElement> = {
	church: ChurchIcon,
	brand: PaintBrush01Icon,
	organization: Building03Icon,
	seats: UserMultipleIcon,
	notifications: Notification01Icon,
	sharing: ShieldUserIcon,
	wiki: BookOpen01Icon,
	account: UserIcon,
};

const DESCRIPTION: Record<SectionKey, string> = {
	church: "Used in emails, documents and Plant Intelligence.",
	brand: "Colors, fonts and letterhead for the documents and emails Everyfield makes for your church.",
	organization: "How your organization appears to the churches you work with.",
	seats: "People who can sign in to your church.",
	notifications: "Your choices only. Other seats set their own.",
	sharing: "Choose what connected organizations can see. Names and personal details are never shared.",
	wiki: "Choose which sending church and network your church reads first in the Wiki.",
	account: "Only you can change these.",
};

export type SettingsDialogProps = {
	section: SectionKey | null;
	onNavigate: (section: SectionKey | null) => void;
	hrefFor: (section: SectionKey) => string;
	slots?: Partial<Record<SectionKey, ReactNode>>;
	pages?: { sections: readonly SectionKey[]; open: (section: SectionKey) => void };
	onDeletionRequested: (status: DeletionStatus | null) => void;
	headerActions?: ReactNode;
};

export function SettingsDialog({
	section,
	onNavigate,
	hrefFor,
	slots = {},
	pages,
	onDeletionRequested,
	headerActions,
}: SettingsDialogProps) {
	const { viewer } = useSettings();
	const dirty = useDirtySections();
	const offered = offeredSections(viewer, [...(Object.keys(slots) as SectionKey[]), ...(pages?.sections ?? [])]);
	const [shown, setShown] = useState<SectionKey | null>(section);
	const [confirming, setConfirming] = useState(false);
	const [moves, setMoves] = useState(0);
	const navLabel = useId();

	const [urlSection, setUrlSection] = useState(section);
	if (section !== urlSection) {
		setUrlSection(section);
		if (section) {
			if (shown && section !== shown) setMoves(moves + 1);
			setShown(section);
		} else if (dirty.keys.length > 0 && shown) setConfirming(true);
		else setShown(null);
	}

	const panel = useFocusRequest<HTMLDivElement>(moves, (root) =>
		confirming || root.contains(root.ownerDocument.activeElement) ? null : currentNavLink(root),
	);

	const hasDirty = dirty.keys.length > 0;
	const frame = useMemo(
		() => ({
			requestClose: () => {
				if (hasDirty) setConfirming(true);
				else {
					setShown(null);
					onNavigate(null);
				}
			},
		}),
		[hasDirty, onNavigate],
	);
	const { requestClose } = frame;
	const discarded = useRef(false);
	const leavingFor = useRef<SectionKey | null>(null);
	const keepEditing = (open: boolean) => {
		if (open) return;
		setConfirming(false);
		leavingFor.current = null;
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
		if (leavingFor.current) pages?.open(leavingFor.current);
		else if (section) onNavigate(null);
	};
	const openPage = (key: SectionKey) => {
		if (dirty.keys.length > 0) {
			leavingFor.current = key;
			setConfirming(true);
		} else {
			setShown(null);
			pages?.open(key);
		}
	};

	const go = (key: SectionKey) => (e: MouseEvent<HTMLAnchorElement>) => {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
		e.preventDefault();
		if (pages?.sections.includes(key)) openPage(key);
		else if (key !== shown) onNavigate(key);
	};

	const current = shown;
	const allowed = current !== null && offered.includes(current);
	const unsavedNames = dirty.keys.map((k) => SECTION_LABEL[k]);

	return (
		<FrameContext value={frame}>
			<Dialog open={current !== null} onOpenChange={(open) => (open ? undefined : requestClose())}>
				<DialogContent
					size="lg"
					aria-describedby={undefined}
					onOpenAutoFocus={(e) => {
						const link = currentNavLink(e.currentTarget as HTMLElement);
						if (!link) return;
						e.preventDefault();
						link.focus();
					}}
					className="h-[min(720px,calc(100dvh-24px))] max-w-[1040px] overflow-hidden bg-surface"
				>
					<div
						ref={panel}
						{...unsavedMark(dirty.keys.length > 0)}
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
									<span className="font-display text-[26px] leading-[1.15] tracking-[-0.02em]">
										{current ? SECTION_LABEL[current] : "Settings"}
									</span>
								}
								description={allowed && current ? DESCRIPTION[current] : undefined}
								actions={headerActions}
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
												: current === "wiki"
													? "Only an Owner or Admin of a church sets the order of its Wiki sources. Ask one of them, or open your own settings."
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

const currentNavLink = (root: HTMLElement) => root.querySelector<HTMLElement>("[data-settings-nav][aria-current=page]");

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
		case "wiki":
			return <WikiSourcesSection />;
		case "account":
			return <AccountSection onDeletionRequested={onDeletionRequested} />;
		case "seats":
		case "sharing":
			return <>{slots[section]}</>;
	}
}
