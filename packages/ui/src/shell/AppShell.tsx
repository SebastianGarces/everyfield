"use client";

import { ArrowDown01Icon, BellIcon, Cancel01Icon, Menu01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Menu, MenuContent, MenuTrigger } from "../controls";
import { AvatarImage } from "../display/AvatarImage";
import { cn, EvryBot, HoverGroup, Icon, Lockup, LogoMark, useHoverItem } from "../foundations";
import { both, useIntentPrefetch } from "../controls/IntentLink";
import { currentKey, linkPrefetch, type ShellItem, type ShellLink, type ShellNav, type ShellUser } from "./nav";
import { RailTip, ThemeToggle } from "./ThemeToggle";

export type ShellActions = {
	onSearch: () => void;
	onNotifications: () => void;
	notificationsOpen: boolean;
	onAskEvry?: () => void;
};

export type AppShellProps = ShellActions & {
	nav: ShellNav;
	user: ShellUser;
	userMenu: ReactNode;
	homeHref: string;
	unread: number;
	banner?: ReactNode;
	width?: "default" | "wide";
	children: ReactNode;
};

const PILL = "bg-surface-raised rounded-nav shadow-nav";

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
						expanded={actions.notificationsOpen}
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
						disabled={!actions.onAskEvry}
						title={actions.onAskEvry ? undefined : "Evry is off on this page"}
						aria-keyshortcuts={actions.onAskEvry ? "Meta+J" : undefined}
						className="inline-flex h-11 items-center gap-[9px] rounded-nav-item bg-surface-2 pr-4 pl-2.5 font-medium text-ink transition-[background-color] hover:bg-surface-3 disabled:opacity-45 disabled:hover:bg-surface-2 max-app-xl:pr-3 max-app-sm:px-2.5"
					>
						<EvryBot size="sm" />
						<span className="max-app-sm:sr-only">{actions.onAskEvry ? "Ask Evry" : "Evry is off"}</span>
					</button>
				</div>

				<Menu>
					<MenuTrigger
						className={cn(
							PILL,
							"flex h-topbar items-center gap-3 pr-4 pl-2.5 text-left transition-[background-color] hover:bg-surface-2 data-[state=open]:bg-surface-2 max-app-xl:pr-3.5 max-app-sm:pr-2.5",
						)}
					>
						<span
							aria-hidden="true"
							className="relative grid size-10 flex-none place-items-center overflow-hidden rounded-full bg-green-100 text-md font-semibold text-green-700"
						>
							{user.initials}
							{user.photo ? <AvatarImage key={user.photo} src={user.photo} /> : null}
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
	const intent = useIntentPrefetch(link.href, link.prefetch === false && !link.onNavigate);
	return (
		<Link
			href={link.href}
			aria-current={current ? "page" : undefined}
			onNavigate={link.onNavigate}
			prefetch={linkPrefetch(link)}
			onPointerEnter={both(handlers.onPointerEnter, intent.onPointerEnter)}
			onFocus={both(handlers.onFocus, intent.onFocus)}
			onTouchStart={intent.onTouchStart}
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
	expanded,
	className,
	children,
}: {
	label: string;
	shortcut?: string;
	onClick: () => void;
	expanded?: boolean;
	className?: string;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			aria-keyshortcuts={shortcut}
			aria-haspopup={expanded === undefined ? undefined : "dialog"}
			aria-expanded={expanded}
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
	const intent = useIntentPrefetch(
		item.kind === "link" ? item.href : "",
		item.kind === "link" && item.prefetch === false && !item.onNavigate,
	);
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
				onPointerEnter={both(handlers.onPointerEnter, intent.onPointerEnter)}
				onFocus={both(handlers.onFocus, intent.onFocus)}
				onTouchStart={intent.onTouchStart}
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

function NarrowMenu({ nav, current, onSearch }: { nav: ShellNav; current: string | null; onSearch: () => void }) {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	const button = useRef<HTMLButtonElement>(null);
	const close = () => setOpen(false);
	const closeOnPointerOutside = useCallback((wrapper: HTMLDivElement | null) => {
		if (!wrapper) return;
		const onPointerDown = (e: PointerEvent) => {
			if (!wrapper.contains(e.target as Node)) setOpen(false);
		};
		wrapper.ownerDocument.addEventListener("pointerdown", onPointerDown);
		return () => wrapper.ownerDocument.removeEventListener("pointerdown", onPointerDown);
	}, []);

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape" && open) {
			e.stopPropagation();
			setOpen(false);
			button.current?.focus();
		}
	};
	const rest = [...nav.pages, ...nav.tools];

	return (
		<div ref={closeOnPointerOutside} role="presentation" onKeyDown={onKeyDown} className="app-md:hidden">
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
	const intent = useIntentPrefetch(
		item.kind === "link" ? item.href : "",
		item.kind === "link" && item.prefetch === false && !item.onNavigate,
	);
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
				onPointerEnter={both(handlers.onPointerEnter, intent.onPointerEnter)}
				onFocus={both(handlers.onFocus, intent.onFocus)}
				onTouchStart={intent.onTouchStart}
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
