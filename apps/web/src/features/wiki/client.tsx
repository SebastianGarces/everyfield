"use client";

import { Bookmark02Icon, Download01Icon, PrinterIcon, Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogHeader,
	IconButton,
	SearchInput,
} from "@everyfield/ui/controls";
import { Tag, Toc, WikiSourceBar, type WikiPhase, WikiTree } from "@everyfield/ui/display";
import Link from "next/link";
import { observeHeadings } from "@everyfield/ui/foundations";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, use, useCallback, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { leaveBeaconMark, shortcutMark } from "../../components/save/leave.ts";
import { useLocalStore, useShallow, useStore } from "../../components/store.ts";
import {
	downloadPdf,
	printCopy,
	recordArticleView,
	saveBookmark,
	saveProgress,
	saveSourceOrder,
	type OrderSave,
} from "./actions.ts";
import {
	createArticleSessionStore,
	type SessionPort,
	type SessionSeed,
	type SessionStore,
} from "./ArticleSession.store.ts";
import { useOpenSettings, useSettingsLink } from "../settings/opener.tsx";
import { ARTICLE_FIXED, BELOW_WIDE_ONLY, GRID, GRID_FIXED, RAIL_FIXED, RAIL_STICKY, RAIL_TOC_PAD } from "./layout.ts";
import { type ArticleVersion, preferredOrder, type SourceOrder, type SourceRow } from "./model.ts";
import { preloadOverlays, useWikiChrome } from "./chrome.tsx";

export function WikiSearchButton() {
	const wiki = useWikiChrome();
	const open = () => wiki?.openSearch();
	return (
		<>
			<div className="max-app-sm:hidden">
				<SearchInput
					readOnly
					placeholder="Search the wiki"
					shortcut="/"
					{...shortcutMark("/")}
					aria-label="Search the wiki"
					onPointerEnter={preloadOverlays}
					onFocus={preloadOverlays}
					onClick={open}
					onKeyDown={(event) => {
						if (event.key !== "Enter" && event.key !== " " && event.key !== "/") return;
						event.preventDefault();
						open();
					}}
				/>
			</div>
			<IconButton
				className="app-sm:hidden"
				icon={Search01Icon}
				label="Search the wiki"
				onPointerEnter={preloadOverlays}
				onFocus={preloadOverlays}
				onClick={open}
				{...shortcutMark("/")}
			/>
		</>
	);
}

type Session = {
	store: SessionStore;
	exporting: boolean;
	exportAs: (kind: "pdf" | "print") => void;
	track: (column: HTMLElement | null) => (() => void) | undefined;
};

const SessionContext = createContext<Session | null>(null);

function useSession(): Session {
	const session = use(SessionContext);
	if (!session) throw new Error("Article tools need an ArticleSession.");
	return session;
}

const SESSION_PORT: SessionPort = { recordView: recordArticleView, saveProgress, saveBookmark, downloadPdf, printCopy };

export function ArticleSession({ children, ...seed }: SessionSeed & { children: ReactNode }) {
	const store = useLocalStore(() => createArticleSessionStore(seed, SESSION_PORT));
	const [exporting, startExport] = useTransition();
	useEffect(() => {
		store.getState().actions.recordView();
	}, [store]);
	const track = useCallback(
		(column: HTMLElement | null) => (column ? store.getState().actions.track(column) : undefined),
		[store],
	);
	const session = useMemo(
		() => ({
			store,
			exporting,
			track,
			exportAs: (kind: "pdf" | "print") => startExport(() => store.getState().actions[kind]()),
		}),
		[store, exporting, track],
	);
	return (
		<SessionContext value={session}>
			{children}
			<ProgressBeacon store={store} />
		</SessionContext>
	);
}

function ProgressBeacon({ store }: { store: SessionStore }) {
	return <span hidden {...leaveBeaconMark(useStore(store, (state) => state.beacon))} />;
}

export function ArticleTools() {
	const { store, exporting, exportAs } = useSession();
	const marked = useStore(store, (state) => state.marked);
	const { toggleBookmark } = useStore(store, (state) => state.actions);
	return (
		<>
			<IconButton
				icon={Bookmark02Icon}
				label={marked ? "Remove bookmark" : "Bookmark"}
				aria-pressed={marked}
				onClick={() => void toggleBookmark()}
				className="aria-pressed:bg-ink aria-pressed:text-on-ink aria-pressed:shadow-none aria-pressed:hover:bg-ink-2 aria-pressed:[&_svg]:fill-current"
			/>
			<IconButton icon={Download01Icon} label="Download PDF" onClick={() => exportAs("pdf")} disabled={exporting} />
			<IconButton icon={PrinterIcon} label="Print" onClick={() => exportAs("print")} disabled={exporting} />
		</>
	);
}

export function ReadStatus({ credit, version }: { credit: string | null; version: ArticleVersion | null }) {
	const { store } = useSession();
	const { percent, done, updated, note } = useStore(
		store,
		useShallow(({ percent, done, updated, note }) => ({ percent, done, updated, note })),
	);
	const text = `${Math.round(Math.min(1, Math.max(0, Number(percent) || 0)) * 100)}% read`;
	return (
		<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 align-middle">
			{done ? (
				<Tag tone="green" icon={Tick02Icon}>
					Read
				</Tag>
			) : (
				<span>{text}</span>
			)}
			{version ? (
				<span className="inline-flex items-center gap-2">
					<Tag tone={version.kind === "church" ? "teal" : "blue"}>
						{version.kind === "church" ? "Church version" : "Network version"}
					</Tag>
					<span className="text-ink">{version.name}</span>
				</span>
			) : null}
			{credit ? <span>· {credit}</span> : null}
			{updated ? <span>· Updated since you read it</span> : null}
			{note ? (
				<span role="status" className="basis-full text-sm text-text-2">
					{note}
				</span>
			) : null}
		</span>
	);
}

type Said = { path: string } & (
	| { saved: { name: string; list: "churches" | "networks"; id: string } }
	| { refused: Exclude<OrderSave, { status: "ok" }> }
);

function refusedText(reply: Exclude<OrderSave, { status: "ok" }>): string {
	switch (reply.status) {
		case "conflict":
		case "required":
		case "invalid":
			return "The preferred source was not changed because the order changed elsewhere. Reload the page to see the current order.";
		case "denied":
			return "The preferred source was not changed. Only an Owner or Admin of your church can set it.";
		case "lost":
			return "The preferred source was not changed. Check your connection and try again.";
	}
}

export function SourceBar({
	sources,
	currentId,
	preferredId,
	canOrder,
	order,
}: {
	sources: SourceRow[];
	currentId: string;
	preferredId: string;
	canOrder: boolean;
	order: SourceOrder | null;
}) {
	const router = useRouter();
	const pathname = usePathname();
	const search = useSearchParams();
	const openSettings = useOpenSettings();
	const [said, setSaid] = useState<Said | null>(null);
	const [saving, setSaving] = useState(false);
	const [loading, startLoading] = useTransition();
	const hrefFor = (id: string) => {
		const params = new URLSearchParams(search.toString());
		if (id === preferredId) params.delete("source");
		else {
			const row = sources.find((source) => source.id === id);
			params.set("source", row?.kind === "global" ? "global" : id);
		}
		const query = params.toString();
		return query ? `${pathname}?${query}` : pathname;
	};
	const current = sources.find((source) => source.id === currentId);
	const next = current ? preferredOrder(order, current, preferredId) : null;
	const prefer = async (name: string, change: NonNullable<typeof next>) => {
		setSaving(true);
		let reply: OrderSave;
		try {
			reply = await saveSourceOrder(crypto.randomUUID(), change.revision, change.churches, change.networks);
		} catch {
			reply = { status: "lost" };
		}
		setSaving(false);
		if (reply.status !== "ok") {
			setSaid({ path: pathname, refused: reply });
			return;
		}
		setSaid({ path: pathname, saved: { name, list: change.list, id: currentId } });
		const params = new URLSearchParams(search.toString());
		params.delete("source");
		const query = params.toString();
		startLoading(() => {
			if (search.has("source")) router.push(query ? `${pathname}?${query}` : pathname);
			else router.refresh();
		});
	};
	const status = (() => {
		if (saving || loading) return "Saving the order…";
		if (!said || said.path !== pathname) return "";
		if ("refused" in said) return refusedText(said.refused);
		const { name, list, id } = said.saved;
		if (list === "churches") return `${name} is now your preferred church.`;
		if (preferredId === id) return `${name} is now your preferred network.`;
		const shown = sources.find((source) => source.id === preferredId)?.name ?? "a church version";
		return `${name} is now your first network. Church versions are read before networks, so this article shows ${shown}.`;
	})();
	return (
		<WikiSourceBar
			sources={sources.map((source) => ({
				id: source.id,
				short: source.short,
				name: source.name,
				meta: source.meta,
				kind: source.barKind,
			}))}
			currentId={currentId}
			preferredId={preferredId}
			onChoose={(id) => {
				setSaid(null);
				router.push(hrefFor(id));
			}}
			prefer={
				current && next && !saving && !loading
					? { name: current.name, onSelect: () => void prefer(current.name, next) }
					: undefined
			}
			status={canOrder ? status : undefined}
			onSettings={canOrder ? () => (openSettings ? openSettings("wiki") : router.push("/settings/wiki")) : undefined}
		/>
	);
}

export function OrderSettingsButton({ children }: { children: ReactNode }) {
	const link = useSettingsLink("wiki");
	return (
		<Button asChild variant="secondary">
			<a {...link}>{children}</a>
		</Button>
	);
}

const SCROLL =
	"overscroll-contain [scrollbar-color:var(--ef-line-2)_transparent] [scrollbar-gutter:stable] [scrollbar-width:thin]";

const RAIL = `${RAIL_FIXED} ${SCROLL}`;

const ARTICLE_SCROLL_ID = "wiki-scroll";

function scrollColumn(): HTMLElement | null {
	const column = document.getElementById(ARTICLE_SCROLL_ID);
	return column && getComputedStyle(column).overflowY !== "visible" ? column : null;
}

type Heading = { id: string; label: string; level?: 2 | 3 };

let sidenavTop = 0;

function keepSidenavPlace(el: HTMLDivElement | null) {
	if (!el) return;
	el.scrollTop = sidenavTop;
	const current = el.querySelector<HTMLElement>('[aria-current="page"]');
	if (current) {
		const box = el.getBoundingClientRect();
		const link = current.getBoundingClientRect();
		if (link.top < box.top) el.scrollTop += link.top - box.top;
		else if (link.bottom > box.bottom) el.scrollTop += link.bottom - box.bottom;
	}
	sidenavTop = el.scrollTop;
}

type Groups = { name: string; items: { id: string; title: string; href: string; read?: boolean }[] }[];

function ArticleTree({
	phases,
	more,
	currentId,
	meter,
}: {
	phases: WikiPhase[];
	more: Groups;
	currentId?: string;
	meter: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-4">
			{phases.length ? <WikiTree phases={phases} currentId={currentId} linkAs={Link} /> : null}
			{more.map((group) => (
				<nav key={group.name} aria-label={group.name}>
					<p className="mb-1 px-2.5 text-sm text-text-3">{group.name}</p>
					<ul className="flex flex-col gap-0.5">
						{group.items.map((item) => (
							<li key={item.id}>
								<Link
									href={item.href}
									aria-current={item.id === currentId ? "page" : undefined}
									className="flex items-center gap-2 rounded-md px-2.5 py-[7px] text-md text-text-2 hover:bg-surface-2 hover:text-ink aria-[current=page]:font-medium aria-[current=page]:text-ink"
								>
									{item.title}
									{item.read ? (
										<>
											<span aria-hidden="true" className="ml-auto size-1.5 flex-none rounded-full bg-green-500" />
											<span className="sr-only">, read</span>
										</>
									) : null}
								</Link>
							</li>
						))}
					</ul>
				</nav>
			))}
			{meter}
		</div>
	);
}

export function ArticleColumns({
	phases,
	more,
	currentId,
	headings,
	children,
	meter,
	fixed,
}: {
	phases: WikiPhase[];
	more: Groups;
	currentId?: string;
	headings: Heading[];
	children: ReactNode;
	meter: ReactNode;
	fixed: boolean;
}) {
	const pathname = usePathname();
	const session = use(SessionContext);
	const [openPath, setOpenPath] = useState<string | null>(null);
	const open = openPath === pathname;
	const [heading, setHeading] = useState(headings[0]?.id);
	const ids = headings.map((item) => item.id).join("|");
	const watchHeadings = useMemo(
		() =>
			observeHeadings(ids ? ids.split("|") : [], setHeading, {
				root: () => scrollColumn(),
				offset: (root) => (root ? 24 : 120),
			}),
		[ids],
	);
	const toc = headings.length ? <Toc items={headings} current={heading} /> : null;
	return (
		<>
			<div className={`mb-4 ${BELOW_WIDE_ONLY}`}>
				<Button variant="secondary" onClick={() => setOpenPath(pathname)}>
					Articles
				</Button>
			</div>
			<Dialog open={open} onOpenChange={(next) => setOpenPath(next ? pathname : null)}>
				<DialogContent>
					<DialogHeader title="Articles" />
					<DialogBody>
						<ArticleTree phases={phases} more={more} currentId={currentId} meter={meter} />
					</DialogBody>
				</DialogContent>
			</Dialog>
			<div className={fixed ? GRID_FIXED : GRID}>
				<div
					ref={keepSidenavPlace}
					onScroll={(event) => {
						sidenavTop = event.currentTarget.scrollTop;
					}}
					className={fixed ? RAIL : RAIL_STICKY}
				>
					<ArticleTree phases={phases} more={more} currentId={currentId} meter={meter} />
				</div>
				<div
					ref={session?.track}
					id={fixed ? ARTICLE_SCROLL_ID : undefined}
					tabIndex={fixed ? 0 : undefined}
					aria-label={fixed ? "Article" : undefined}
					className={fixed ? `${ARTICLE_FIXED} ${SCROLL}` : "min-w-0"}
				>
					<div className={`mb-6 ${BELOW_WIDE_ONLY}`}>{toc}</div>
					{children}
				</div>
				<div ref={watchHeadings} className={fixed ? `${RAIL} ${RAIL_TOC_PAD}` : RAIL_STICKY}>
					{toc}
				</div>
			</div>
		</>
	);
}
