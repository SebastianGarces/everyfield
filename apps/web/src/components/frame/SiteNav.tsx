"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { buttonClass } from "../ButtonLink";
import { cn } from "../cn";

export type NavLink = { href: string; label: string; current: boolean };
type Which = "inflow" | "pill";

type Props = {
	links: NavLink[];
	cta: NavLink;
	/** Server-rendered pieces, passed in so their SVG stays out of the client bundle. */
	logo: ReactNode;
	pillLogo: ReactNode;
	arrow: ReactNode;
	menuIcon: ReactNode;
};

/**
 * The site header in two copies: the in-flow header at the top of the page and the floating pill that slides in once
 * the in-flow header has scrolled out of view. Exactly one is exposed to assistive tech at a time (the other is inert
 * and aria-hidden), so there is one banner and one Main nav. While focus is inside the in-flow header it stays the
 * exposed one, even after it scrolls away; once focus leaves, the pill takes over. Below 1121 px each copy has its own
 * menu: Escape closes it and returns focus to its toggle, and a link click closes it.
 */
export function SiteNav({ links, cta, logo, pillLogo, arrow, menuIcon }: Props) {
	const inflowRef = useRef<HTMLElement>(null);
	const inflowToggle = useRef<HTMLButtonElement>(null);
	const pillToggle = useRef<HTMLButtonElement>(null);
	const pillOnRef = useRef(false);
	const [pillOn, setPillOn] = useState(false);
	const [focusInHeader, setFocusInHeader] = useState(false);
	const [open, setOpen] = useState<Which | null>(null);

	// The pill shows once the in-flow header is entirely above the viewport. An IntersectionObserver reports that
	// change; nothing runs per scroll frame and nothing reads layout.
	useEffect(() => {
		const header = inflowRef.current;
		if (!header) return;
		const io = new IntersectionObserver(([entry]) => {
			const on = !entry!.isIntersecting;
			if (on === pillOnRef.current) return;
			pillOnRef.current = on;
			setPillOn(on);
			// A menu belongs to the bar that showed it; switching bars closes it.
			setOpen(null);
		});
		io.observe(header);
		return () => io.disconnect();
	}, []);

	// Escape closes the open menu and returns focus to its toggle. Listens only while a menu is open.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setOpen(null);
			(open === "pill" ? pillToggle : inflowToggle).current?.focus();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open]);

	const pillLive = pillOn && !focusInHeader;
	const onBlur = () =>
		requestAnimationFrame(() => setFocusInHeader(!!inflowRef.current?.contains(document.activeElement)));
	const bar = (which: Which) => (
		<NavBar
			which={which}
			links={links}
			cta={cta}
			logo={which === "pill" ? pillLogo : logo}
			arrow={arrow}
			menuIcon={menuIcon}
			open={open === which}
			toggleRef={which === "pill" ? pillToggle : inflowToggle}
			onToggle={() => setOpen((o) => (o === which ? null : which))}
			onLinkClick={(e) => {
				if ((e.target as Element).closest("a")) setOpen(null);
			}}
		/>
	);

	return (
		<>
			<header
				ref={inflowRef}
				className="relative z-50"
				inert={pillLive}
				aria-hidden={pillLive || undefined}
				onFocus={() => setFocusInHeader(true)}
				onBlur={onBlur}
			>
				{bar("inflow")}
			</header>
			<header
				data-on={pillOn}
				inert={!pillLive}
				aria-hidden={!pillLive || undefined}
				className={cn(
					"fixed inset-x-0 top-3 z-60 mx-auto w-full max-w-mk rounded-nav bg-white shadow-mk-pill will-change-[transform,opacity]",
					// Slides down 360 ms with the hero ease-out; transform and opacity only. Hidden, it waits for the slide to end
					// before it turns invisible.
					"invisible opacity-0 [transform:translate3d(0,calc(-100%_-_16px),0)]",
					"[transition:transform_.36s_var(--ease-mk-out),opacity_.36s_var(--ease-mk-out),visibility_0s_linear_.36s]",
					"data-[on=true]:visible data-[on=true]:opacity-100 data-[on=true]:[transform:none]",
					"data-[on=true]:[transition:transform_.36s_var(--ease-mk-out),opacity_.36s_var(--ease-mk-out),visibility_0s_linear_0s]",
					"motion-reduce:[transition:none] motion-reduce:data-[on=true]:[transition:none]",
					// Phones: the pill floats inside the page margin and clear of the notch (E8).
					"max-mk-sm:top-[calc(12px_+_env(safe-area-inset-top))] max-mk-sm:right-[max(var(--spacing-page),env(safe-area-inset-right))] max-mk-sm:left-[max(var(--spacing-page),env(safe-area-inset-left))] max-mk-sm:w-auto",
				)}
			>
				{bar("pill")}
			</header>
		</>
	);
}

type BarProps = {
	which: Which;
	links: NavLink[];
	cta: NavLink;
	logo: ReactNode;
	arrow: ReactNode;
	menuIcon: ReactNode;
	open: boolean;
	toggleRef: RefObject<HTMLButtonElement | null>;
	onToggle: () => void;
	onLinkClick: (e: MouseEvent) => void;
};

const LINK =
	"whitespace-nowrap rounded-nav-item px-[11px] py-2 text-text-2 no-underline hover:bg-mk-line hover:text-ink " +
	"aria-[current=page]:font-semibold aria-[current=page]:text-ink max-mk-nav:px-2 max-mk-nav:py-3 max-mk-nav:type-lg";
const MENU = {
	inflow:
		"max-mk-nav:absolute max-mk-nav:inset-x-0 max-mk-nav:top-[70px] max-mk-nav:flex-col max-mk-nav:border-b max-mk-nav:border-mk-line " +
		"max-mk-nav:bg-mk-canvas max-mk-nav:px-page max-mk-nav:pt-3 max-mk-nav:pb-5 max-mk-nav:shadow-mk-menu max-mk-sm:top-16",
	pill:
		"max-mk-nav:absolute max-mk-nav:inset-x-0 max-mk-nav:top-[calc(100%_+_8px)] max-mk-nav:flex-col max-mk-nav:border " +
		"max-mk-nav:border-mk-line max-mk-nav:bg-white max-mk-nav:px-4 max-mk-nav:pt-3 max-mk-nav:pb-4 max-mk-nav:shadow-mk-menu",
};

function NavBar({ which, links, cta, logo, arrow, menuIcon, open, toggleRef, onToggle, onLinkClick }: BarProps) {
	const pill = which === "pill";
	const menuId = pill ? "pill-menu" : "site-menu";
	return (
		<div
			className={cn(
				"mx-auto flex max-w-mk items-center gap-7 px-page max-mk-sm:gap-3",
				// The pill's last control sits as far from the right edge as from the top and bottom: (60 - 44) / 2.
				pill ? "h-[60px] pr-2 max-mk-sm:h-14 max-mk-sm:pr-[7px]" : "h-[70px] max-mk-sm:h-16",
			)}
		>
			<Link href="/" aria-label="Everyfield home" className="flex flex-none items-center no-underline">
				{logo}
			</Link>
			<nav
				id={menuId}
				aria-label="Main"
				onClick={onLinkClick}
				className={cn("flex gap-1 type-md", open ? MENU[which] : "max-mk-nav:hidden")}
			>
				{links.map((l) => (
					<Link key={l.href} href={l.href} aria-current={l.current ? "page" : undefined} className={LINK}>
						{l.label}
					</Link>
				))}
				{pill ? null : (
					// Phones (440 px and below) have no room for the request button in the header, so the menu carries it.
					<Link
						href={cta.href}
						aria-current={cta.current ? "page" : undefined}
						className="mt-2 hidden h-12 items-center self-start whitespace-nowrap bg-ink px-5 type-lg font-semibold text-cream no-underline hover:bg-ink-2 active:translate-y-px max-mk-xs:inline-flex"
					>
						{cta.label}
					</Link>
				)}
			</nav>
			<div className="ml-auto flex items-center gap-2">
				<Link
					href={cta.href}
					aria-current={cta.current ? "page" : undefined}
					className={buttonClass("primary", pill ? "pill" : "nav", pill ? undefined : "max-mk-xs:hidden")}
				>
					{cta.label}
					{arrow}
				</Link>
				<button
					ref={toggleRef}
					type="button"
					aria-label="Menu"
					aria-expanded={open}
					aria-controls={menuId}
					onClick={onToggle}
					className={cn(
						"hidden cursor-pointer place-items-center rounded-nav-item border-0 bg-cream text-ink hover:bg-mk-surface-3 max-mk-nav:grid",
						pill ? "size-11 max-mk-sm:size-[42px]" : "size-[42px]",
					)}
				>
					{menuIcon}
				</button>
			</div>
		</div>
	);
}
