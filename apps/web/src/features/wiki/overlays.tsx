"use client";

import { Search01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogHeader,
	EmptyState,
	SearchInput,
	Select,
	Sheet,
	StatePanel,
} from "@everyfield/ui/controls";
import { createDebouncer } from "@everyfield/ui/foundations";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { createRead, useRead } from "../../components/read.tsx";
import type { GuideResult, SearchResult } from "./actions.ts";
import { searchWiki } from "./fetch.ts";
import { guides } from "./guides.ts";
import { PHASE_NAME, snippetParts } from "./model.ts";
import { ArticleBody } from "./prose.tsx";
import { READ_FAILED, loadProblem, failedIcon } from "../../components/read-failed.ts";
import type { ReadFailure } from "../../components/get-reads.ts";

const PHASES = [
	{ value: "all", label: "All phases" },
	...PHASE_NAME.map((name, number) => ({ value: String(number), label: `${number} ${name}` })),
];

const SEARCH_DELAY_MS = 250;

const searches = createRead(
	(text: string, phase: string, page: number, source: string | null) =>
		searchWiki(text, phase === "all" ? null : Number(phase), page, source),
	{ failed: (): SearchResult | ReadFailure => ({ status: "lost" }) },
);

type Asked = { text: string; phase: string; page: number; source: string | null };

export function SearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const source = useSearchParams().get("source");
	const [query, setQuery] = useState("");
	const [asked, setAsked] = useState<Asked>({ text: "", phase: "all", page: 1, source: null });
	const [pause] = useState(() => createDebouncer(SEARCH_DELAY_MS));
	const found = useRead(asked.text ? searches : null, asked.text, asked.phase, asked.page, asked.source);
	const [shown, setShown] = useState<{ page: number; result: SearchResult | ReadFailure } | null>(null);
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

function SearchBody({
	result,
	pending,
	query,
}: {
	result: SearchResult | ReadFailure | null;
	pending: boolean;
	query: string;
}) {
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

function SearchResults({ result }: { result: SearchResult | ReadFailure }) {
	if (result.status === "lost" || result.status === "failed")
		return (
			<StatePanel tone="error" title="Search could not be loaded" icon={failedIcon(result)} headingLevel="h3">
				{loadProblem(result, "This is a loading problem. Try again.")}
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

export function GuideSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
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

function GuideBody({ result }: { result: GuideResult | ReadFailure | null }) {
	if (!result) return <p>Loading the guide.</p>;
	if (result.status === "missing") return <p>No guide for this page.</p>;
	if (result.status === "denied") return <p>Sign in to read the guide.</p>;
	if (result.status === "unavailable") return <p>The guide could not be loaded. Try again.</p>;
	if (result.status === "failed") return <p>{READ_FAILED}</p>;
	return (
		<article className="flex flex-col gap-4">
			<header>
				<p className="text-sm text-text-3">From the Wiki</p>
				<h3 className="mt-0.5 font-title text-[21px] leading-tight tracking-[-0.02em] text-ink">{result.title}</h3>
			</header>
			<ArticleBody size="excerpt" contentType="safe_mdx" body={result.excerpt} />
			<Link
				href={result.href}
				className="self-start font-medium text-ink underline decoration-green-500 decoration-2 underline-offset-[3px]"
			>
				Open the article
			</Link>
		</article>
	);
}
