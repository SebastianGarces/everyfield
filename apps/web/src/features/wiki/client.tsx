"use client";

import { Bookmark02Icon, Download01Icon, PrinterIcon, Search01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	EmptyState,
	IconButton,
	SearchInput,
	Select,
	Sheet,
	StatePanel,
} from "@everyfield/ui/controls";
import { Toc, useActiveHeading, WikiSourceBar, type WikiPhase, WikiTree } from "@everyfield/ui/display";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, use, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
	downloadPdf,
	loadGuide,
	printCopy,
	readSourceOrder,
	recordArticleView,
	saveBookmark,
	saveProgress,
	saveSourceOrder,
	searchWiki,
	type GuideResult,
	type OrderRow,
	type SearchResult,
	type WriteResult,
} from "./actions.ts";
import { fractionText, pdfFilename, PHASE_NAME, snippetParts, type SourceRow } from "./model.ts";

const Chrome = createContext<{ openSearch: () => void; openGuide: () => void; guideOpen: boolean } | null>(null);

export function useWikiChrome() {
	return use(Chrome);
}

/** Guide and wiki search, mounted once on the product frame. Guide never records a reading. */
export function WikiChrome({ children }: { children: ReactNode }) {
	const [search, setSearch] = useState(false);
	const [guide, setGuide] = useState(false);
	const pathname = usePathname();
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
			if (!pathname.startsWith("/wiki")) return;
			const target = event.target;
			if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable=true]")) return;
			event.preventDefault();
			setSearch(true);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [pathname]);
	return (
		<Chrome value={{ openSearch: () => setSearch(true), openGuide: () => setGuide(true), guideOpen: guide }}>
			{children}
			<SearchDialog open={search} onOpenChange={setSearch} />
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
					aria-label="Search the wiki"
					boxClassName="w-[280px]"
					onFocus={open}
					onClick={open}
				/>
			</div>
			<IconButton className="app-sm:hidden" icon={Search01Icon} label="Search the wiki" onClick={open} />
		</>
	);
}

const PHASES = [
	{ value: "all", label: "All phases" },
	...PHASE_NAME.map((name, number) => ({ value: String(number), label: `${number} ${name}` })),
];

function SearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const params = useSearchParams();
	const pathname = usePathname();
	const route = useRef(pathname);
	const [query, setQuery] = useState("");
	const [phase, setPhase] = useState("all");
	const [page, setPage] = useState(1);
	const [result, setResult] = useState<SearchResult | null>(null);
	const [pending, setPending] = useState(false);
	const field = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (route.current === pathname) return;
		route.current = pathname;
		onOpenChange(false);
	}, [pathname, onOpenChange]);

	async function run(nextPage: number, text = query) {
		const trimmed = text.trim();
		if (!trimmed) {
			setResult(null);
			return;
		}
		setPending(true);
		const found = await searchWiki(trimmed, phase === "all" ? null : Number(phase), nextPage, params.get("source"));
		setResult(found);
		setPage(nextPage);
		setPending(false);
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
				<DialogBody className="flex flex-col gap-4">
					<form
						className="flex flex-col gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							void run(1);
						}}
					>
						<SearchInput
							ref={field}
							value={query}
							maxLength={200}
							placeholder="Search the wiki"
							aria-label="Search words"
							onChange={(event) => setQuery(event.target.value)}
						/>
						<div className="flex flex-wrap items-center gap-2">
							<Select
								aria-label="Phase"
								value={phase}
								options={PHASES}
								onValueChange={setPhase}
								className="w-[240px]"
							/>
							<Button type="submit" loading={pending}>
								Search
							</Button>
						</div>
					</form>
					<SearchBody result={result} pending={pending} query={query.trim()} />
					{result?.status === "results" && result.nextPage ? (
						<Button variant="secondary" onClick={() => void run(page + 1)} loading={pending}>
							Next page
						</Button>
					) : null}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

function SearchBody({ result, pending, query }: { result: SearchResult | null; pending: boolean; query: string }) {
	if (!query) return <p className="text-text-2">Type a word to search the wiki.</p>;
	if (pending && !result) return <p className="text-text-2">Searching.</p>;
	if (!result || result.status === "lost")
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

function GuideSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const pathname = usePathname();
	const [result, setResult] = useState<{ path: string; value: GuideResult } | null>(null);
	useEffect(() => {
		if (!open) return;
		let live = true;
		void loadGuide(pathname).then((next) => {
			if (live) setResult({ path: pathname, value: next });
		});
		return () => {
			live = false;
		};
	}, [open, pathname]);
	const shown = result?.path === pathname ? result.value : null;
	return (
		<Sheet
			open={open}
			onOpenChange={onOpenChange}
			title="Guide"
			description="A short note for this page."
			modal={false}
		>
			<GuideBody result={shown} />
		</Sheet>
	);
}

function GuideBody({ result }: { result: GuideResult | null }) {
	if (!result) return <p>Loading the guide.</p>;
	if (result.status === "missing") return <p>No guide for this page.</p>;
	if (result.status === "gone") return <p>This guide is no longer available.</p>;
	if (result.status === "denied") return <p>Sign in to read the guide.</p>;
	if (result.status === "unavailable") return <p>The guide could not be loaded. Try again.</p>;
	return (
		<div className="flex flex-col gap-3">
			{result.title ? <p className="font-medium text-ink">{result.title}</p> : null}
			{result.body ? <p className="whitespace-pre-wrap">{result.body}</p> : null}
			{result.citation ? <p className="text-sm text-text-3">{result.citation}</p> : null}
			{result.href ? (
				<Link
					href={result.href}
					className="font-medium text-ink underline decoration-green-500 decoration-2 underline-offset-[3px]"
				>
					Open the article
				</Link>
			) : null}
		</div>
	);
}

type ArticleProps = {
	articleId: string;
	slug: string;
	source: string | null;
	readingRevision: string;
	plantId?: string;
	bookmarked: boolean;
	observedFraction: string;
	completed: boolean;
	updated: boolean;
};

export function ArticleTools(props: ArticleProps) {
	const revision = useRef(props.readingRevision);
	const chain = useRef<Promise<WriteResult | void>>(Promise.resolve());
	const seen = useRef(Number(props.observedFraction) || 0);
	const viewKey = useRef(crypto.randomUUID());
	// Strict mode runs this effect twice. The second view would reuse the request key
	// after the revision moved, and the write gate would report a conflict.
	const recorded = useRef<string | null>(null);
	const bookmarkKey = useRef(crypto.randomUUID());
	const [marked, setMarked] = useState(props.bookmarked);
	const [percent, setPercent] = useState(props.observedFraction);
	const [done, setDone] = useState(props.completed);
	const [updated, setUpdated] = useState(props.updated);
	const [note, setNote] = useState("");
	const [fallback, setFallback] = useState<string | null>(null);
	const [busy, setBusy] = useState<"pdf" | "print" | null>(null);

	function enqueue(task: (rev: string) => Promise<WriteResult>) {
		chain.current = chain.current.then(async () => {
			const result = await task(revision.current);
			if (result.status === "ok") {
				revision.current = result.revision;
				setMarked(result.bookmarked);
				setPercent(result.observedFraction);
				setDone(result.completed);
				if (result.updated) setUpdated(true);
				setNote("");
			} else if (result.status === "conflict") setNote("Reload the page, then try again.");
			else if (result.status === "denied") setNote("You cannot change this article.");
			else setNote("That did not save. Try again.");
			return result;
		});
		return chain.current;
	}

	useEffect(() => {
		if (recorded.current !== props.articleId) {
			recorded.current = props.articleId;
			viewKey.current = crypto.randomUUID();
			void enqueue((rev) =>
				recordArticleView({
					requestKey: viewKey.current,
					expectedRevision: rev,
					articleId: props.articleId,
					plantId: props.plantId,
				}),
			);
		}
		const article = document.getElementById("wiki-article");
		if (!article) return;
		let timer = 0;
		const measure = () => {
			const total = article.scrollHeight;
			if (total <= 0) return;
			const rect = article.getBoundingClientRect();
			const visible = Math.min(total, Math.max(0, window.innerHeight - rect.top));
			const next = Math.min(1, visible / total);
			if (next <= seen.current + 0.01) return;
			seen.current = next;
			void enqueue((rev) =>
				saveProgress(
					{
						requestKey: crypto.randomUUID(),
						expectedRevision: rev,
						articleId: props.articleId,
						plantId: props.plantId,
					},
					fractionText(next),
				),
			);
		};
		const onScroll = () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(measure, 500);
		};
		measure();
		window.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", onScroll);
		return () => {
			window.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", onScroll);
			window.clearTimeout(timer);
		};
		// Record the open once. Later scrolls use the revision that write returned.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.articleId]);

	async function toggleBookmark() {
		const desired = !marked;
		setMarked(desired);
		const result = await enqueue((rev) =>
			saveBookmark({ requestKey: bookmarkKey.current, expectedRevision: rev, articleId: props.articleId }, desired),
		);
		if (!result || result.status !== "ok") setMarked(!desired);
		else bookmarkKey.current = crypto.randomUUID();
	}

	async function pdf() {
		setBusy("pdf");
		setFallback(null);
		const result = await downloadPdf(props.articleId, props.source);
		setBusy(null);
		if (result.status === "pdf") {
			saveFile(pdfFilename(props.slug), result.bytes);
			return;
		}
		if (result.status === "print" && result.fallback) {
			setFallback(result.html);
			setNote("The PDF font failed. You can print the article instead.");
			return;
		}
		setNote(result.status === "denied" ? "You cannot download this article." : "The PDF could not be made. Try again.");
	}

	async function printArticle() {
		setBusy("print");
		const result = fallback
			? { status: "print" as const, html: fallback, fallback: true }
			: await printCopy(props.articleId, props.source);
		setBusy(null);
		if (result.status === "print") {
			if (!openPrint(result.html)) setNote("Allow pop-up windows to print this article.");
			return;
		}
		setNote(result.status === "denied" ? "You cannot print this article." : "Print could not be prepared. Try again.");
	}

	const read = done ? "Read" : `${Math.round(Math.min(1, Math.max(0, Number(percent) || 0)) * 100)}% read`;
	return (
		<div className="flex flex-col items-end gap-2">
			<div className="flex flex-wrap items-center gap-2">
				<IconButton
					icon={Bookmark02Icon}
					label={marked ? "Remove bookmark" : "Bookmark"}
					aria-pressed={marked}
					onClick={() => void toggleBookmark()}
				/>
				<IconButton icon={Download01Icon} label="Download PDF" onClick={() => void pdf()} disabled={busy !== null} />
				<IconButton icon={PrinterIcon} label="Print" onClick={() => void printArticle()} disabled={busy !== null} />
			</div>
			<p className="text-sm text-text-2">
				{read}
				{updated ? " · Updated since you read it" : ""}
			</p>
			{note ? (
				<p role="status" className="max-w-[280px] text-right text-sm text-text-2">
					{note}
				</p>
			) : null}
		</div>
	);
}

function saveFile(filename: string, bytes: string) {
	const binary = atob(bytes);
	const data = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
	const url = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}

function openPrint(html: string): boolean {
	const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
	const popup = window.open(url);
	if (!popup) return false;
	popup.addEventListener("load", () => popup.print());
	return true;
}

export function SourceBar({
	sources,
	currentId,
	preferredId,
	canOrder,
}: {
	sources: SourceRow[];
	currentId: string;
	preferredId: string;
	canOrder: boolean;
}) {
	const router = useRouter();
	const pathname = usePathname();
	const search = useSearchParams();
	const order = search.get("order") === "edit";
	const hrefFor = (id: string) => {
		const params = new URLSearchParams(search.toString());
		params.delete("order");
		if (id === preferredId) params.delete("source");
		else {
			const row = sources.find((source) => source.id === id);
			params.set("source", row?.kind === "global" ? "global" : id);
		}
		const query = params.toString();
		return query ? `${pathname}?${query}` : pathname;
	};
	const settings = new URLSearchParams(search.toString());
	settings.set("order", "edit");
	return (
		<>
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
				onChoose={(id) => router.push(hrefFor(id))}
				settingsHref={canOrder ? `${pathname}?${settings.toString()}` : undefined}
			/>
			{canOrder ? <SourceOrder open={order} /> : null}
		</>
	);
}

function SourceOrder({ open }: { open: boolean }) {
	const router = useRouter();
	const pathname = usePathname();
	const search = useSearchParams();
	const [churches, setChurches] = useState<OrderRow[]>([]);
	const [networks, setNetworks] = useState<OrderRow[]>([]);
	const [revision, setRevision] = useState("0");
	const [note, setNote] = useState("");
	const [pending, setPending] = useState(false);
	const loaded = useRef(false);

	useEffect(() => {
		if (!open) {
			loaded.current = false;
			return;
		}
		if (loaded.current) return;
		loaded.current = true;
		void readSourceOrder().then((result) => {
			if (result.status !== "ok") {
				setNote(
					result.status === "denied"
						? "Only an Owner or Admin can set this order."
						: "The source order could not be loaded.",
				);
				return;
			}
			setChurches(result.churches);
			setNetworks(result.networks);
			setRevision(result.revision);
		});
	}, [open]);

	function close() {
		const params = new URLSearchParams(search.toString());
		params.delete("order");
		const query = params.toString();
		router.replace(query ? `${pathname}?${query}` : pathname);
	}

	function move(kind: "church" | "network", index: number, step: number) {
		const list = kind === "church" ? churches : networks;
		const next = index + step;
		if (next < 0 || next >= list.length) return;
		const copy = list.slice();
		const [row] = copy.splice(index, 1);
		if (!row) return;
		copy.splice(next, 0, row);
		if (kind === "church") setChurches(copy);
		else setNetworks(copy);
	}

	async function save() {
		setPending(true);
		const result = await saveSourceOrder(
			crypto.randomUUID(),
			revision,
			churches.map((row) => row.id),
			networks.map((row) => row.id),
		);
		setPending(false);
		if (result.status === "ok") {
			router.refresh();
			close();
			return;
		}
		if (result.status === "conflict") setNote("Someone else changed the order. Reload the page, then try again.");
		else if (result.status === "required") setNote("Choose every church. An empty church list cannot set the order.");
		else if (result.status === "invalid") setNote("The order has to list each source once.");
		else if (result.status === "denied") setNote("Only an Owner or Admin can set this order.");
		else setNote("The order did not save. Try again.");
	}

	return (
		<Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
			<DialogContent size="md">
				<DialogHeader
					title="Preferred source order"
					description="This order chooses the article people see first. It does not hide the other sources."
				/>
				<DialogBody className="flex flex-col gap-4">
					<OrderList title="Churches" rows={churches} kind="church" onMove={move} />
					<OrderList title="Networks" rows={networks} kind="network" onMove={move} />
					{note ? (
						<p role="status" className="text-sm text-text-2">
							{note}
						</p>
					) : null}
				</DialogBody>
				<DialogFooter>
					<Button variant="ghost" onClick={close}>
						Cancel
					</Button>
					<Button onClick={() => void save()} loading={pending} disabled={churches.length + networks.length === 0}>
						Save order
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function OrderList({
	title,
	rows,
	kind,
	onMove,
}: {
	title: string;
	rows: OrderRow[];
	kind: "church" | "network";
	onMove: (kind: "church" | "network", index: number, step: number) => void;
}) {
	const label = useId();
	if (!rows.length) return <p className="text-text-2">No {title.toLowerCase()} share a wiki with this church.</p>;
	return (
		<div>
			<p id={label} className="mb-2 font-medium text-ink">
				{title}
			</p>
			<ol aria-labelledby={label} className="flex flex-col gap-1">
				{rows.map((row, index) => (
					<li key={row.id} className="flex items-center justify-between gap-3 rounded-md bg-surface-2 px-3 py-2">
						<span className="min-w-0 truncate text-ink">{row.name}</span>
						<span className="flex gap-1">
							<Button variant="ghost" size="sm" onClick={() => onMove(kind, index, -1)} disabled={index === 0}>
								Move up
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => onMove(kind, index, 1)}
								disabled={index === rows.length - 1}
							>
								Move down
							</Button>
						</span>
					</li>
				))}
			</ol>
		</div>
	);
}

export function TocRail({ items }: { items: { id: string; label: string; level?: 2 | 3 }[] }) {
	const current = useActiveHeading(items.map((item) => item.id));
	if (!items.length) return null;
	return <Toc items={items} current={current} />;
}

export function ArticleColumns({
	phases,
	more,
	currentId,
	toc,
	children,
	meter,
}: {
	phases: WikiPhase[];
	more: { name: string; items: { id: string; title: string; href: string; read?: boolean }[] }[];
	currentId?: string;
	toc: ReactNode;
	children: ReactNode;
	meter: ReactNode;
}) {
	const pathname = usePathname();
	const [openPath, setOpenPath] = useState<string | null>(null);
	const open = openPath === pathname;
	const tree = () => (
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
	return (
		<>
			<div className="mb-4 app-lg:hidden">
				<Button variant="secondary" onClick={() => setOpenPath(pathname)}>
					Articles
				</Button>
			</div>
			<Dialog open={open} onOpenChange={(next) => setOpenPath(next ? pathname : null)}>
				<DialogContent>
					<DialogHeader title="Articles" />
					<DialogBody>{tree()}</DialogBody>
				</DialogContent>
			</Dialog>
			<div className="grid items-start gap-8 app-lg:grid-cols-[250px_minmax(0,1fr)_220px]">
				<div className="hidden app-lg:sticky app-lg:top-24 app-lg:block">{tree()}</div>
				<div className="min-w-0">
					<div className="mb-6 app-lg:hidden">{toc}</div>
					{children}
				</div>
				<div className="hidden app-lg:sticky app-lg:top-24 app-lg:block">{toc}</div>
			</div>
		</>
	);
}
