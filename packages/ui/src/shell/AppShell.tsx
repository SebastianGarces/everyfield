"use client";

import { ArrowDown01Icon, BellIcon, Cancel01Icon, Menu01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Menu, MenuContent, MenuTrigger } from "../controls";
import { cn, EvryBot, HoverGroup, Icon, Lockup, LogoMark, useHoverItem } from "../foundations";
import { currentKey, linkPrefetch, type ShellItem, type ShellLink, type ShellNav, type ShellUser } from "./nav";
import { RailTip, ThemeToggle } from "./ThemeToggle";

/** What the top-bar controls do. The overlays they open (command palette, notifications, Evry) belong to other packages. */
export type ShellActions = {
	onSearch: () => void;
	onNotifications: () => void;
	onAskEvry: () => void;
};

export type AppShellProps = ShellActions & {
	nav: ShellNav;
	user: ShellUser;
	/** The user menu's items (MenuItem, MenuLabel, MenuSeparator). The name button in the top bar opens it. */
	userMenu: ReactNode;
	/** The Overview link behind the logo. */
	homeHref: string;
	/** Unread notifications. A dot shows on the bell when there are any. */
	unread: number;
	/** Shown above the page, such as the Member role banner. */
	banner?: ReactNode;
	/** Dense list pages (People, Meetings, Documents) use the wide content column. */
	width?: "default" | "wide";
	children: ReactNode;
};

const PILL = "bg-surface-raised rounded-nav shadow-nav";

/**
 * The product frame: a top bar of separate pills, an icon rail on the left and a content column (foundations.md, Layout).
 * The top bar and rail span the window; the column stops at 1536px (1920px when wide) and centers beside the rail.
 *
 * Narrow screens (below 1024px) are not drawn in the prototype. There the rail and the top navigation move into one
 * Menu panel under the top bar, so every destination stays one tap away. Below 640px, Search moves into that panel
 * and Ask Evry keeps only the character.
 */
export function AppShell({
	nav,
	user,
	homeHref,
	unread,
	banner,
	width = "default",
	userMenu,
	children,
	...actions
}: AppShellProps) {
	const pathname = usePathname();
	const current = currentKey(nav, pathname);

	return (
		<div className="relative grid min-h-dvh grid-cols-[96px_minmax(0,1fr)] grid-rows-[auto_1fr] bg-frame max-app-md:grid-cols-[minmax(0,1fr)]">
			<a
				href="#main"
				className="sr-only rounded-nav-item bg-ink px-4 py-3 font-medium text-on-ink focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50"
			>
				Skip to content
			</a>
			<Topbar
				nav={nav}
				user={user}
				userMenu={userMenu}
				homeHref={homeHref}
				unread={unread}
				current={current}
				actions={actions}
			/>
			<Rail nav={nav} current={current} />
			<main
				id="main"
				tabIndex={-1}
				data-width={width}
				className="w-full min-w-0 max-w-content justify-self-center pt-[18px] pr-[26px] pb-24 pl-[10px] outline-none data-[width=wide]:max-w-content-wide max-app-md:px-4 max-app-md:pt-2"
			>
				{banner}
				{children}
			</main>
		</div>
	);
}

function Topbar({
	nav,
	user,
	userMenu,
	homeHref,
	unread,
	current,
	actions,
}: {
	nav: ShellNav;
	user: ShellUser;
	userMenu: ReactNode;
	homeHref: string;
	unread: number;
	current: string | null;
	actions: ShellActions;
}) {
	return (
		<header className="sticky top-0 z-20 col-span-full flex items-center gap-[14px] bg-[linear-gradient(var(--ef-frame)_78%,transparent)] pt-[22px] pr-6 pb-2 pl-[22px] *:flex-none *:whitespace-nowrap max-app-xl:gap-2.5 max-app-md:gap-2 max-app-md:px-3 max-app-md:pt-3 app-2xl:grid app-2xl:grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)]">
			<Link
				href={homeHref}
				aria-label="Everyfield, Overview"
				className={cn(PILL, "flex h-topbar items-center px-6 text-ink max-app-lg:px-2.5 app-2xl:justify-self-start")}
			>
				<Lockup className="h-[26px] w-auto max-app-lg:hidden" />
				<span className="grid size-10 flex-none place-items-center app-lg:hidden">
					<LogoMark className="h-auto w-6" />
				</span>
			</Link>

			<nav
				aria-label="Main"
				className={cn(
					PILL,
					"mx-auto flex h-topbar flex-[0_1_auto] items-center px-2 max-app-md:hidden app-2xl:mx-0 app-2xl:justify-self-center",
				)}
			>
				<HoverGroup current={current} className="flex items-center gap-0.5">
					{nav.main.map((link) => (
						<TopNavItem key={link.key} link={link} current={current === link.key} />
					))}
				</HoverGroup>
			</nav>

			<NarrowMenu nav={nav} current={current} onSearch={actions.onSearch} />

			<div className="flex items-center gap-[14px] max-app-xl:gap-2.5 max-app-md:ml-auto max-app-md:gap-2 app-2xl:justify-self-end">
				<div className={cn(PILL, "flex h-topbar items-center gap-1.5 px-2")}>
					<TopIconButton label="Search" shortcut="Meta+K" onClick={actions.onSearch} className="max-app-sm:hidden">
						<Icon icon={Search01Icon} size={24} />
					</TopIconButton>
					<TopIconButton
						label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
						onClick={actions.onNotifications}
					>
						<Icon icon={BellIcon} size={24} />
						{unread > 0 && (
							<span
								aria-hidden="true"
								className="absolute top-[7px] right-[7px] size-2 rounded-full bg-amber-500 ring-2 ring-surface-raised"
							/>
						)}
					</TopIconButton>
					<button
						type="button"
						onClick={actions.onAskEvry}
						aria-keyshortcuts="Meta+J"
						className="inline-flex h-11 items-center gap-[9px] rounded-nav-item bg-surface-2 pr-4 pl-2.5 font-medium text-ink transition-[background-color] hover:bg-surface-3 max-app-xl:pr-3 max-app-sm:px-2.5"
					>
						<EvryBot size="sm" />
						<span className="max-app-sm:sr-only">Ask Evry</span>
					</button>
				</div>

				{/* The accessible name is the visible text (label in name, WCAG 2.5.3): the name and role line stay in the
            accessibility tree when narrow screens hide them, and a hidden suffix says what the button opens. */}
				<Menu>
					<MenuTrigger
						className={cn(
							PILL,
							"flex h-topbar items-center gap-3 pr-4 pl-2.5 text-left transition-[background-color] hover:bg-surface-2 data-[state=open]:bg-surface-2 max-app-xl:pr-3.5 max-app-sm:pr-2.5",
						)}
					>
						<span
							aria-hidden="true"
							className="grid size-10 flex-none place-items-center rounded-full bg-green-100 text-md font-semibold text-green-700"
						>
							{user.initials}
						</span>
						<span className="leading-[1.2] max-app-lg:sr-only">
							<span className="block text-nav font-semibold">{user.name}</span>
							<span className="block text-xs text-text-3 max-app-xl:sr-only">{user.detail}</span>
						</span>
						<span className="sr-only">, account menu</span>
						<Icon icon={ArrowDown01Icon} size={16} className="text-text-3 max-app-sm:hidden" />
					</MenuTrigger>
					<MenuContent align="end" className="w-[260px]">
						{userMenu}
					</MenuContent>
				</Menu>
			</div>
		</header>
	);
}

function TopNavItem({ link, current }: { link: ShellLink; current: boolean }) {
	const { handlers, indicator } = useHoverItem(link.key);
	return (
		<Link
			href={link.href}
			aria-current={current ? "page" : undefined}
			onNavigate={link.onNavigate}
			prefetch={linkPrefetch(link)}
			{...handlers}
			className="relative inline-flex h-11 items-center gap-2 rounded-nav-item px-4 text-nav text-ink-2 aria-[current=page]:bg-ink aria-[current=page]:text-on-ink aria-[current=page]:shadow-nav-active max-app-xl:px-[13px]"
		>
			{indicator}
			{link.label}
		</Link>
	);
}

function TopIconButton({
	label,
	shortcut,
	onClick,
	className,
	children,
}: {
	label: string;
	shortcut?: string;
	onClick: () => void;
	className?: string;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			aria-keyshortcuts={shortcut}
			onClick={onClick}
			className={cn(
				"relative grid size-11 place-items-center rounded-nav-item text-ink-2 transition-[background-color] hover:bg-surface-2",
				className,
			)}
		>
			{children}
		</button>
	);
}

function Rail({ nav, current }: { nav: ShellNav; current: string | null }) {
	return (
		<aside
			aria-label="Secondary"
			className="sticky top-[92px] z-[25] flex h-[calc(100dvh-112px)] flex-col gap-[14px] pt-[18px] pb-5 pl-[22px] max-app-md:hidden"
		>
			<ThemeToggle variant="rail" />
			<div className="flex-[.6]" />
			<RailGroup items={nav.pages} current={current} />
			<div className="flex-1" />
			<RailGroup items={nav.tools} current={current} />
		</aside>
	);
}

function RailGroup({ items, current }: { items: readonly ShellItem[]; current: string | null }) {
	if (items.length === 0) return null;
	return (
		<HoverGroup current={current} className={cn(PILL, "flex w-16 flex-col items-center gap-1.5 py-2.5")}>
			{items.map((item) => (
				<RailItem key={item.key} item={item} current={current === item.key} />
			))}
		</HoverGroup>
	);
}

const RAIL_ITEM =
	"group/ri relative grid size-[46px] place-items-center rounded-nav-item text-ink-2 aria-[current=page]:bg-ink aria-[current=page]:text-on-ink aria-[current=page]:shadow-nav-active aria-expanded:bg-ink aria-expanded:text-on-ink aria-expanded:shadow-nav-active";

function RailItem({ item, current }: { item: ShellItem; current: boolean }) {
	const { handlers, indicator } = useHoverItem(item.key);
	const body = (
		<>
			{indicator}
			<Icon icon={item.icon} size={24} />
			<RailTip>{item.label}</RailTip>
		</>
	);
	if (item.kind === "link") {
		return (
			<Link
				href={item.href}
				aria-current={current ? "page" : undefined}
				onNavigate={item.onNavigate}
				prefetch={linkPrefetch(item)}
				{...handlers}
				className={RAIL_ITEM}
			>
				{body}
			</Link>
		);
	}
	return (
		<button type="button" onClick={item.onSelect} aria-expanded={item.expanded} {...handlers} className={RAIL_ITEM}>
			{body}
		</button>
	);
}

/**
 * The narrow-screen menu: a disclosure button and one panel with every destination and the theme switch. The panel is
 * hidden (so inert) when closed. Esc, a choice or a tap outside closes it, and Esc returns focus to the button.
 */
function NarrowMenu({ nav, current, onSearch }: { nav: ShellNav; current: string | null; onSearch: () => void }) {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	const button = useRef<HTMLButtonElement>(null);
	const wrapper = useRef<HTMLDivElement>(null);
	const close = () => setOpen(false);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape" && open) {
			e.stopPropagation();
			setOpen(false);
			button.current?.focus();
		}
	};
	const rest = [...nav.pages, ...nav.tools];

	return (
		<div ref={wrapper} onKeyDown={onKeyDown} className="app-md:hidden">
			<div className={cn(PILL, "flex h-topbar items-center px-2")}>
				<button
					ref={button}
					type="button"
					aria-expanded={open}
					aria-controls={panelId}
					onClick={() => setOpen((o) => !o)}
					className="inline-flex h-11 items-center gap-2 rounded-nav-item px-3 text-nav text-ink-2 transition-[background-color] hover:bg-surface-2 aria-expanded:bg-ink aria-expanded:text-on-ink"
				>
					<Icon icon={open ? Cancel01Icon : Menu01Icon} size={24} />
					<span className="max-app-sm:sr-only">Menu</span>
				</button>
			</div>
			<div
				id={panelId}
				hidden={!open}
				className="absolute inset-x-3 top-full mt-2 max-h-[calc(100dvh-104px)] overflow-y-auto rounded-card bg-surface-raised p-3 shadow-pop"
			>
				<nav aria-label="Main">
					<HoverGroup current={current} className="grid gap-1 app-sm:grid-cols-2">
						{nav.main.map((link) => (
							<MenuRow key={link.key} item={link} current={current === link.key} onChoose={close} />
						))}
					</HoverGroup>
				</nav>
				{rest.length > 0 && (
					<>
						<div className="mx-3 my-3 h-px bg-line-2" />
						<HoverGroup current={current} className="grid gap-1 app-sm:grid-cols-2">
							<MenuSearch
								onChoose={() => {
									close();
									onSearch();
								}}
							/>
							{rest.map((item) => (
								<MenuRow key={item.key} item={item} current={current === item.key} onChoose={close} />
							))}
						</HoverGroup>
					</>
				)}
				<div className="mx-3 my-3 h-px bg-line-2" />
				<ThemeToggle variant="menu" />
			</div>
		</div>
	);
}

const MENU_ROW =
	"relative flex h-12 w-full items-center gap-3 rounded-nav-item px-3 text-left text-nav text-ink-2 aria-[current=page]:bg-ink aria-[current=page]:text-on-ink aria-[current=page]:shadow-nav-active aria-expanded:bg-ink aria-expanded:text-on-ink";

function MenuRow({ item, current, onChoose }: { item: ShellItem; current: boolean; onChoose: () => void }) {
	const { handlers, indicator } = useHoverItem(item.key);
	const body = (
		<>
			{indicator}
			<Icon icon={item.icon} size={20} />
			{item.label}
		</>
	);
	if (item.kind === "link") {
		return (
			<Link
				href={item.href}
				aria-current={current ? "page" : undefined}
				onClick={onChoose}
				onNavigate={item.onNavigate}
				prefetch={linkPrefetch(item)}
				{...handlers}
				className={MENU_ROW}
			>
				{body}
			</Link>
		);
	}
	return (
		<button
			type="button"
			aria-expanded={item.expanded}
			{...handlers}
			className={MENU_ROW}
			onClick={() => {
				onChoose();
				item.onSelect();
			}}
		>
			{body}
		</button>
	);
}

/** Search sits in the menu only below 640px, where the top bar has no room for it. */
function MenuSearch({ onChoose }: { onChoose: () => void }) {
	const { handlers, indicator } = useHoverItem("search");
	return (
		<button
			type="button"
			onClick={onChoose}
			aria-keyshortcuts="Meta+K"
			{...handlers}
			className={cn(MENU_ROW, "app-sm:hidden")}
		>
			{indicator}
			<Icon icon={Search01Icon} size={20} />
			Search
		</button>
	);
}
