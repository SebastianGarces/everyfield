import { ProductFrameLayout } from "@/features/people/routes";
import { Button, Card, StatePanel } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { editPath, isCrawler, parseSource, splitWikiPath, wikiReturn } from "./model.ts";
import { WikiScreen } from "./screen.tsx";
import { loadPreview, loadWiki } from "./server.ts";

// /wiki stays outside the product frame so a crawler never receives the signed-in shell.
// A person gets that frame from here, after the preview check.

type Search = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

async function requestPath(slug: string): Promise<string> {
	return slug
		? `/wiki/${slug
				.split("/")
				.map((part) => encodeURIComponent(part))
				.join("/")}`
		: "/wiki";
}

export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }): Promise<Metadata> {
	const { slug, editing } = splitWikiPath((await params).slug);
	const userAgent = (await headers()).get("user-agent");
	if (editing || !isCrawler(userAgent))
		return { title: editing ? "Edit article" : "Wiki", robots: { index: false, follow: false } };
	const path = await requestPath(slug);
	const preview = await loadPreview(path, userAgent ?? "");
	if (!preview?.allowed || !preview.crawler) return { title: "Wiki", robots: { index: false, follow: false } };
	return { title: preview.title ?? "Wiki", description: preview.excerpt ?? undefined };
}

export async function WikiPage({
	params,
	searchParams,
}: {
	params: Promise<{ slug?: string[] }>;
	searchParams: Search;
}) {
	const { slug, editing } = splitWikiPath((await params).slug);
	const path = editing ? editPath(slug) : await requestPath(slug);
	const userAgent = (await headers()).get("user-agent");
	if (isCrawler(userAgent)) {
		const preview = await loadPreview(await requestPath(slug), userAgent ?? "");
		if (preview?.crawler && preview.allowed) return <PublicPreview title={preview.title} excerpt={preview.excerpt} />;
	}
	const query = await searchParams;
	const source = parseSource(one(query.source));
	const data = await loadWiki(slug, source, one(query.order) === "edit", editing);
	if (data === "signed-out") redirect(`/signin?returnTo=${encodeURIComponent(wikiReturn(path, source))}`);
	if (data === "lost") {
		return (
			<ProductFrameLayout>
				<Card>
					<StatePanel
						tone="error"
						title="We could not load the wiki"
						headingLevel="h1"
						actions={
							<Button asChild>
								<Link href={path}>Try again</Link>
							</Button>
						}
					>
						This is a loading problem, not an empty wiki. Try again in a moment.
					</StatePanel>
				</Card>
			</ProductFrameLayout>
		);
	}
	return (
		<ProductFrameLayout>
			<WikiScreen data={data} source={one(query.source) ?? null} />
		</ProductFrameLayout>
	);
}

function PublicPreview({ title, excerpt }: { title: string | null; excerpt: string | null }) {
	return (
		<main className="mx-auto max-w-[700px] px-6 py-16">
			<h1 className="font-display text-[40px] tracking-[-0.02em] text-ink">{title ?? "Wiki"}</h1>
			{excerpt ? <p className="mt-4 text-text-2">{excerpt}</p> : null}
			{!title ? <p className="mt-4 text-text-2">This page has no public preview.</p> : null}
		</main>
	);
}
