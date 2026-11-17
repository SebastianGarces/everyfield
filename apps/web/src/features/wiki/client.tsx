"use client";

import {
	BookOpen02Icon,
	Bookmark02Icon,
	Download01Icon,
	PrinterIcon,
	Search01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogHeader,
	EmptyState,
	IconButton,
	SearchInput,
	Select,
	Sheet,
	StatePanel,
} from "@everyfield/ui/controls";
import { Tag, Toc, WikiSourceBar, type WikiPhase, WikiTree } from "@everyfield/ui/display";
import Link from "next/link";
import { createDebouncer, observeHeadings } from "@everyfield/ui/foundations";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
	createContext,
	use,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useTransition,
	type ReactNode,
} from "react";
import { createRead, useRead } from "../../components/read.tsx";
import { leaveBeaconMark, shortcutMark } from "../../components/save/leave.ts";
import { useLocalStore, useShallow, useStore } from "../../components/store.ts";
import {
	downloadPdf,
	loadGuide,
	printCopy,
	recordArticleView,
	saveBookmark,
	saveProgress,
	saveSourceOrder,
	searchWiki,
	type GuideResult,
	type OrderSave,
	type SearchResult,
} from "./actions.ts";
import {
	createArticleSessionStore,
	type SessionPort,
	type SessionSeed,
	type SessionStore,
} from "./ArticleSession.store.ts";
import { useOpenSettings, useSettingsLink } from "../settings/opener.tsx";
import { ARTICLE_FIXED, BELOW_WIDE_ONLY, GRID, GRID_FIXED, RAIL_FIXED, RAIL_STICKY, RAIL_TOC_PAD } from "./layout.ts";
import {
	type ArticleVersion,
	PHASE_NAME,
	preferredOrder,
	snippetParts,
	type SourceOrder,
	type SourceRow,
} from "./model.ts";
import { ArticleBody } from "./prose.tsx";

const Chrome = createContext<{ openSearch: () => void; toggleGuide: () => void; guideOpen: boolean } | null>(null);

export function useWikiChrome() {
	return use(Chrome);
}

export function WikiChrome({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	const [searchPath, setSearchPath] = useState<string | null>(null);
	const [guide, setGuide] = useState(false);
	if (searchPath !== null && searchPath !== pathname) setSearchPath(null);
	const chrome = useMemo(
		() => ({
			openSearch: () => setSearchPath(pathname),
			toggleGuide: () => {
				if (!guide) guides.refresh(pathname);
				setGuide(!guide);
			},
			guideOpen: guide,
		}),
		[pathname, guide],
	);
	return (
		<Chrome value={chrome}>
			{children}
			<SearchDialog open={searchPath === pathname} onOpenChange={(next) => setSearchPath(next ? pathname : null)} />
			<GuideSheet open={guide} onOpenChange={setGuide} />
		</Chrome>
	);
}

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
					boxClassName="w-[280px]"
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
				onClick={open}
				{...shortcutMark("/")}
			/>
		</>
	);
}

const PHASES = [
	{ value: "all", label: "All phases" },
	...PHASE_NAME.map((name, number) => ({ value: String(number), label: `${number} ${name}` })),
];

const SEARCH_DELAY_MS = 250;

const searches = createRead(
	(text: string, phase: string, page: number, source: string | null) =>
		searchWiki(text, phase === "all" ? null : Number(phase), page, source),
	{ failed: (): SearchResult => ({ status: "lost" }) },
);

type Asked = { text: string; phase: string; page: number; source: string | null };

function SearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const source = useSearchParams().get("source");
	const [query, setQuery] = useState("");
	const [asked, setAsked] = useState<Asked>({ text: "", phase: "all", page: 1, source: null });
	const [pause] = useState(() => createDebouncer(SEARCH_DELAY_MS));
	const found = useRead(asked.text ? searches : null, asked.text, asked.phase, asked.page, asked.source);
	const [shown, setShown] = useState<{ page: number; result: SearchResult } | null>(null);
	const latest = !asked.text ? null : found.value ? { page: asked.page, result: found.value } : shown;
	if (latest?.result !== shown?.result) setShown(latest);
	const pending = query.trim() !== asked.text || found.status === "loading";
	const field = useRef<HTMLInputElement | null>(null);

	function ask(text: string, phase: string, page: number) {
		pause.cancel();
		const next = { text: text.trim(), phase, page, source };
		if (next.text) void searches.refresh(next.text, next.phase, next.page, next.source);
		setAsked(next);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				size="lg"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					field.current?.focus();
				}}
			>
				<DialogHeader title="Search the wiki" description="Search titles, excerpts and article text." />
				<DialogBody className="flex flex-col gap-4 pt-1 pb-7 max-app-sm:pb-5">
					<form
						className="flex flex-col gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							ask(query, asked.phase, 1);
						}}
					>
						<SearchInput
							ref={field}
							value={query}
							maxLength={200}
							placeholder="Search the wiki"
							aria-label="Search words"
							onChange={(event) => {
								const text = event.target.value;
								setQuery(text);
								pause.run(() => ask(text, asked.phase, 1));
							}}
						/>
						<Select
							aria-label="Phase"
							value={asked.phase}
							options={PHASES}
							onValueChange={(next) => ask(query, next, 1)}
							className="w-[240px]"
						/>
					</form>
					<SearchBody result={shown?.result ?? null} pending={pending} query={query.trim()} />
					{shown?.result.status === "results" && shown.result.nextPage ? (
						<Button variant="secondary" onClick={() => ask(query, asked.phase, shown.page + 1)} loading={pending}>
							Next page
						</Button>
					) : null}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

function SearchBody({ result, pending, query }: { result: SearchResult | null; pending: boolean; query: string }) {
	if (!query || (!result && !pending)) return <p className="text-text-2">Type a word to search the wiki.</p>;
	if (!result) return <p className="text-text-2">Searching.</p>;
	if (!pending) return <SearchResults result={result} />;
	return (
		<div className="flex flex-col gap-3" aria-busy="true">
			<p className="text-text-2">Searching.</p>
			<div className="opacity-50">
				<SearchResults result={result} />
			</div>
		</div>
	);
}

function SearchResults({ result }: { result: SearchResult }) {
	if (result.status === "lost")
		return (
			<StatePanel tone="error" title="Search could not be loaded" headingLevel="h3">
				This is a loading problem. Try again.
			</StatePanel>
		);
	if (result.status === "unavailable")
		return (
			<StatePanel tone="error" title="Search is unavailable right now" headingLevel="h3">
				The wiki is still there. Try again in a moment.
			</StatePanel>
		);
	if (result.status === "denied")
		return (
			<StatePanel tone="lock" title="Sign in to search the wiki" headingLevel="h3">
				Search uses your account. It does not run for a signed-out visit.
			</StatePanel>
		);
	if (result.status === "empty")
		return (
			<EmptyState icon={Search01Icon} title="No articles match">
				Nothing in your wiki matches that search. Try a different word or phase.
			</EmptyState>
		);
	return (
		<ul className="flex flex-col gap-2">
			{result.hits.map((hit) => (
				<li key={hit.articleId}>
					<Link
						href={`/wiki/${hit.slug
							.split("/")
							.map((part) => encodeURIComponent(part))
							.join("/")}`}
						className="block rounded-md px-3 py-2.5 hover:bg-surface-2"
					>
						<span className="block font-medium text-ink">{hit.title}</span>
						{hit.excerpt ? <Snippet text={hit.excerpt} /> : null}
					</Link>
				</li>
			))}
		</ul>
	);
}

function Snippet({ text }: { text: string }) {
	const parts = snippetParts(text);
	return (
		<span className="mt-1 block text-sm text-text-2">
			{parts.map((part, index) =>
				part.mark ? (
					<mark key={index} className="bg-transparent font-medium text-ink">
						{part.text}
					</mark>
				) : (
					<span key={index}>{part.text}</span>
				),
			)}
		</span>
	);
}

export function SettingsGuide() {
	const pathname = usePathname();
	const [open, setOpen] = useState(false);
	return (
		<>
			<IconButton
				icon={BookOpen02Icon}
				label="Guide"
				size="sm"
				aria-expanded={open}
				onClick={() => {
					if (!open) guides.refresh(pathname);
					setOpen(!open);
				}}
			/>
			<GuideSheet open={open} onOpenChange={setOpen} />
		</>
	);
}

const guides = createRead((path: string) => loadGuide(path), {
	failed: (): GuideResult => ({ status: "unavailable" }),
});

function GuideSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const guide = useRead(open ? guides : null, usePathname());
	return (
		<Sheet
			open={open}
			onOpenChange={onOpenChange}
			title="Guide"
			description="A short note for this page."
			modal={false}
		>
			<GuideBody result={guide.value ?? null} />
		</Sheet>
	);
}

function GuideBody({ result }: { result: GuideResult | null }) {
	if (!result) return <p>Loading the guide.</p>;
	if (result.status === "missing") return <p>No guide for this page.</p>;
	if (result.status === "denied") return <p>Sign in to read the guide.</p>;
	if (result.status === "unavailable") return <p>The guide could not be loaded. Try again.</p>;
	return (
		<article className="flex flex-col gap-4">
			<header>
				<p className="text-sm text-text-3">From the Wiki</p>
				<h3 className="mt-0.5 font-title text-[21px] leading-tight tracking-[-0.02em] text-ink">{result.title}</h3>
			</header>
			<ArticleBody
				size="sm"
				contentType="safe_mdx"
				body={result.excerpt}
				className="[&>:first-child]:mt-0! [&>:last-child]:mb-0 [&_h2]:mt-5! [&_h2]:mb-1.5! [&_h2]:font-body! [&_h2]:text-[16px]! [&_h2]:font-semibold [&_h3]:mt-4! [&_h3]:mb-1! [&_h3]:font-body! [&_h3]:text-[15px]! [&_h3]:font-medium"
			/>
			<Link
				href={result.href}
				className="self-start font-medium text-ink underline decoration-green-500 decoration-2 underline-offset-[3px]"
			>
				Open the article
			</Link>
		</article>
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
