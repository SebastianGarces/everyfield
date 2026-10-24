import { BookOpen01Icon } from "@hugeicons/core-free-icons";
import { Card, EmptyState, PageHeader, StatePanel } from "@everyfield/ui/controls";
import Link from "next/link";
import { ArticleTools, ArticleColumns, SourceBar, TocRail, WikiSearchButton } from "./client.tsx";
import { articleBlocks, articlePath, humanCredit, percentLabel, PHASE_NAME, type Listed } from "./model.ts";
import { ArticleBody } from "./prose.tsx";
import type { WikiPageData } from "./server.ts";

// The signed-in wiki. The crawler preview does not use this screen.

function Meter({ label, done, total }: { label: string; done: number; total: number }) {
	const width = total === 0 ? 0 : Math.round((done / total) * 100);
	return (
		<div className="rounded-md bg-surface-2 p-3.5">
			<div className="flex items-center justify-between gap-3 text-sm">
				<span className="text-text-2">{label}</span>
				<span className="font-medium text-ink">
					{done} of {total}
				</span>
			</div>
			<div
				className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface"
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={total}
				aria-valuenow={done}
				aria-label={label}
			>
				<div className="h-full bg-ink" style={{ width: `${width}%` }} />
			</div>
		</div>
	);
}

function ArticleList({ title, articles }: { title: string; articles: Listed[] }) {
	if (!articles.length) return null;
	return (
		<section className="mt-8">
			<h2 className="mb-3 font-title text-[22px] tracking-[-0.02em] text-ink">{title}</h2>
			<ul className="flex flex-col gap-2">
				{articles.map((article) => (
					<li key={article.articleId}>
						<Link
							href={articlePath(article.slug)}
							className="block rounded-md bg-surface px-4 py-3 shadow-card hover:bg-surface-2"
						>
							<span className="block font-medium text-ink">{article.title}</span>
							<span className="mt-1 block text-sm text-text-2">
								{article.completed ? "Read" : percentLabel(article.observedFraction)}
								{article.excerpt ? ` · ${article.excerpt}` : ""}
							</span>
						</Link>
					</li>
				))}
			</ul>
		</section>
	);
}

export function WikiScreen({ data, source }: { data: WikiPageData; source: string | null }) {
	const article = data.article;
	const headings = article?.article.body
		? articleBlocks(article.article.contentType, article.article.body).flatMap((block) =>
				block.kind === "heading" ? [{ id: block.id, label: block.text, level: block.level }] : [],
			)
		: [];
	const title = article?.article.title ?? "Wiki";
	const phase = article?.article.phase;
	const credit = article ? humanCredit(article.article.credit) : null;
	return (
		<>
			<PageHeader
				title={title}
				size={article ? "default" : "xl"}
				breadcrumb={
					article
						? [
								{ label: "Wiki", href: "/wiki" },
								...(phase != null ? [{ label: PHASE_NAME[phase] ?? `Phase ${phase}` }] : []),
								{ label: article.article.title },
							]
						: undefined
				}
				subtitle={
					article ? (
						<>
							{percentLabel(article.article.observedFraction)}
							{credit ? ` · ${credit}` : ""}
							{article.article.updatedLabel ? " · Updated since you read it" : ""}
						</>
					) : (
						`${data.readCount} of ${data.articleCount} articles read`
					)
				}
				actions={
					article ? (
						<>
							<WikiSearchButton />
							<ArticleTools
								articleId={article.article.articleId}
								slug={article.article.slug}
								source={source}
								readingRevision={article.readingRevision}
								plantId={article.plantId}
								bookmarked={article.article.bookmarked}
								observedFraction={article.article.observedFraction}
								completed={article.article.completed}
								updated={article.article.updatedLabel}
							/>
						</>
					) : (
						<WikiSearchButton />
					)
				}
			/>
			{article && article.sources.length ? (
				<div className="mb-6">
					<SourceBar
						sources={article.sources}
						currentId={article.currentSourceId}
						preferredId={article.preferredSourceId}
						canOrder={article.canOrder}
					/>
				</div>
			) : null}
			<ArticleColumns
				phases={data.tree.phases}
				more={data.tree.more}
				currentId={article?.article.articleId}
				toc={<TocRail items={headings} />}
				meter={
					data.phaseRead ? (
						<Meter
							label={`Phase ${data.phaseRead.phase} read`}
							done={data.phaseRead.done}
							total={data.phaseRead.total}
						/>
					) : data.articleCount ? (
						<Meter label="Articles read" done={data.readCount} total={data.articleCount} />
					) : null
				}
			>
				{data.missing ? (
					<Card>
						<StatePanel tone="lock" title="This article is not available" headingLevel="h2">
							It is not in the wiki you can read. Pick another article from the list.
						</StatePanel>
					</Card>
				) : article?.block === "order" ? (
					<Card>
						<StatePanel tone="neutral" title="Choose a source order" headingLevel="h2">
							This church has more than one Wiki source. An Owner or Admin sets the order before a source can be chosen
							for you. You can still open a named source above.
						</StatePanel>
					</Card>
				) : article?.block === "hidden" ? (
					<Card>
						<StatePanel tone="lock" title="This source is hidden" headingLevel="h2">
							The article text stays hidden. Choose another source to read a published version.
						</StatePanel>
					</Card>
				) : article?.block === "denied" ? (
					<Card>
						<StatePanel tone="lock" title="You cannot read this source" headingLevel="h2">
							Your account does not include this version. Choose another source, or go back to your preferred one.
						</StatePanel>
					</Card>
				) : article?.article.body ? (
					<div id="wiki-article" className="rounded-card bg-surface px-6 py-8 shadow-card max-app-sm:px-4 sm:px-11">
						<ArticleBody contentType={article.article.contentType} body={article.article.body} />
						{article.siblings.length ? (
							<section className="mx-auto mt-10 max-w-[700px]">
								<h2 className="mb-3 font-title text-[22px] tracking-[-0.02em] text-ink">In this section</h2>
								<ul className="flex flex-col gap-1">
									{article.siblings.map((item) => (
										<li key={item.articleId}>
											<Link
												href={articlePath(item.slug)}
												className="text-ink underline decoration-green-500 decoration-2 underline-offset-[3px]"
											>
												{item.title}
											</Link>
										</li>
									))}
								</ul>
							</section>
						) : null}
						{article.related.length ? (
							<section className="mx-auto mt-8 max-w-[700px]">
								<h2 className="mb-3 font-title text-[22px] tracking-[-0.02em] text-ink">Related</h2>
								<ul className="flex flex-col gap-1">
									{article.related.map((item) => (
										<li key={item.articleId}>
											<Link
												href={item.href}
												className="text-ink underline decoration-green-500 decoration-2 underline-offset-[3px]"
											>
												{item.title}
											</Link>
										</li>
									))}
								</ul>
							</section>
						) : null}
					</div>
				) : (
					<>
						{!data.tree.phases.length && !data.tree.more.length ? (
							<Card>
								<EmptyState icon={BookOpen01Icon} title="No articles yet">
									Published wiki articles will show up here.
								</EmptyState>
							</Card>
						) : null}
						<ArticleList title="Continue reading" articles={data.resume ? [data.resume] : []} />
						<ArticleList title="Recent" articles={data.recent} />
						<ArticleList title="Bookmarks" articles={data.bookmarks} />
						<ArticleList title="Suggested" articles={data.recommended} />
					</>
				)}
			</ArticleColumns>
		</>
	);
}
