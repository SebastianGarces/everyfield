"use client";

import { START_CHURCH } from "@everyfield/contracts/identity";
import {
	ArrowRight01Icon,
	BookOpen01Icon,
	ChurchIcon,
	CheckmarkCircle02Icon,
	File02Icon,
	HierarchyIcon,
	Link01Icon,
	Mortarboard01Icon,
} from "@hugeicons/core-free-icons";
import { Button, Card, CardIcon, PageHeader } from "@everyfield/ui/controls";
import { cn, EvryBot, Icon } from "@everyfield/ui/foundations";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEvryOpener } from "../../components/evry-opener.ts";

export type DiscoveryHomeData = {
	firstName: string | null;
	foundations: { id: string; title: string; href: string; read: boolean }[];
	links: { id: string; name: string; kind: string; sharesFoundations: boolean }[];
	residency: { organizationName: string } | null;
};

const ROW =
	"flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function DiscoveryHome({ data }: { data: DiscoveryHomeData }) {
	const read = data.foundations.filter((a) => a.read).length;
	const total = data.foundations.length;
	return (
		<div className="flex flex-col gap-5">
			<PageHeader
				size="xl"
				title={data.firstName ? `Welcome, ${data.firstName}` : "Welcome to Discovery"}
				subtitle="Discovery is free for as long as you need. Read, write and test the call before you start a church."
			/>
			{data.residency ? (
				<Card className="flex flex-wrap items-center gap-x-4 gap-y-3">
					<CardIcon icon={Mortarboard01Icon} tone="teal" size={36} />
					<div className="min-w-[200px] flex-1">
						<h2 className="font-sans text-md font-semibold tracking-normal text-ink">
							Your residency with {data.residency.organizationName}
						</h2>
						<p className="text-sm text-text-2">Your program, next meeting, milestones and reading.</p>
					</div>
					<Button asChild variant="secondary">
						<Link href="/my-residency">Open My residency</Link>
					</Button>
				</Card>
			) : null}
			<div className="grid gap-5 app-lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
				<Card as="section" aria-labelledby="foundations-heading">
					<div className="flex items-start gap-3">
						<CardIcon icon={BookOpen01Icon} tone="blue" size={36} />
						<div className="min-w-0 flex-1">
							<h2 id="foundations-heading" className="font-sans text-md font-semibold tracking-normal text-ink">
								Foundations
							</h2>
							<p className="text-sm text-text-2">
								{read} of {total} read. Read them in any order. They never block starting a church.
							</p>
						</div>
					</div>
					<ol className="mt-3 flex flex-col">
						{data.foundations.map((article) => (
							<li key={article.id}>
								<Link href={article.href} className={ROW}>
									<Icon
										icon={article.read ? CheckmarkCircle02Icon : BookOpen01Icon}
										size={18}
										className={article.read ? "text-green-700" : "text-text-3"}
									/>
									<span className="min-w-0 flex-1">{article.title}</span>
									<span className="sr-only">{article.read ? "(read)" : "(not read yet)"}</span>
									<Icon icon={ArrowRight01Icon} size={16} className="text-text-3" />
								</Link>
							</li>
						))}
					</ol>
				</Card>
				<div className="flex flex-col gap-5">
					<Tile
						icon={BookOpen01Icon}
						title="The Wiki"
						text="Every published article, from discerning the call to the first years after launch."
						action={
							<Button asChild variant="secondary" size="sm">
								<Link href="/wiki">Open the Wiki</Link>
							</Button>
						}
					/>
					<Tile
						icon={File02Icon}
						title="Your documents"
						text="Private documents only you can see. Start from a template or write your own."
						action={
							<Button asChild variant="secondary" size="sm">
								<Link href="/documents">Open Documents</Link>
							</Button>
						}
					/>
					<AskEvry />
				</div>
			</div>
			<div className="grid gap-5 app-lg:grid-cols-2">
				<Card as="section" aria-labelledby="links-heading">
					<div className="flex items-start gap-3">
						<CardIcon icon={HierarchyIcon} tone="violet" size={36} />
						<div className="min-w-0 flex-1">
							<h2 id="links-heading" className="font-sans text-md font-semibold tracking-normal text-ink">
								Sending church or network
							</h2>
							{data.links.length ? (
								<ul className="mt-2 flex flex-col gap-2">
									{data.links.map((link) => (
										<li key={link.id} className="text-sm">
											<span className="font-medium text-ink">{link.name}</span>
											<span className="text-text-3"> · {link.kind}</span>
											<span className="block text-text-2">
												{link.sharesFoundations
													? "Sees your name, when you connected and your foundations reading."
													: "Sees your name and when you connected."}
											</span>
										</li>
									))}
								</ul>
							) : (
								<p className="mt-1 text-sm text-text-2 text-pretty">
									Not connected yet. A sending church or network can walk with you, and later cover your church’s seat.
								</p>
							)}
						</div>
					</div>
					<div className="mt-4">
						<Button asChild variant="secondary" size="sm" icon={Link01Icon}>
							<Link href="/settings/sharing#connections">{data.links.length ? "Manage connections" : "Connect"}</Link>
						</Button>
					</div>
				</Card>
				<Card as="section" aria-labelledby="start-heading">
					<div className="flex items-start gap-3">
						<CardIcon icon={ChurchIcon} tone="amber" size={36} />
						<div className="min-w-0 flex-1">
							<h2 id="start-heading" className="font-sans text-md font-semibold tracking-normal text-ink">
								When you’re ready
							</h2>
							<p className="mt-1 text-sm text-text-2 text-pretty">
								Start your church when the time is right. Your documents and your connections come with you, and
								People, Meetings, Tasks and the rest open.
							</p>
						</div>
					</div>
					<div className="mt-4">
						<Button asChild variant="secondary" size="sm">
							<Link href={START_CHURCH}>Start a church</Link>
						</Button>
					</div>
				</Card>
			</div>
		</div>
	);
}

function Tile({
	icon,
	title,
	text,
	action,
	className,
}: {
	icon: Parameters<typeof CardIcon>[0]["icon"];
	title: string;
	text: string;
	action: ReactNode;
	className?: string;
}) {
	return (
		<Card as="section" className={cn("flex flex-col gap-3", className)}>
			<div className="flex items-start gap-3">
				<CardIcon icon={icon} tone="ink" size={36} />
				<div className="min-w-0 flex-1">
					<h2 className="font-sans text-md font-semibold tracking-normal text-ink">{title}</h2>
					<p className="text-sm text-text-2 text-pretty">{text}</p>
				</div>
			</div>
			<div>{action}</div>
		</Card>
	);
}

function AskEvry() {
	const open = useEvryOpener();
	if (!open) return null;
	return (
		<Card as="section" className="flex flex-col gap-3">
			<div className="flex items-start gap-3">
				<EvryBot size="md" mood="idle" />
				<div className="min-w-0 flex-1">
					<h2 className="font-sans text-md font-semibold tracking-normal text-ink">Ask Evry</h2>
					<p className="text-sm text-text-2 text-pretty">
						Ask about a Wiki article or one of your documents. Evry never changes a document until you OK it.
					</p>
				</div>
			</div>
			<div>
				<Button variant="secondary" size="sm" onClick={open}>
					Ask Evry
				</Button>
			</div>
		</Card>
	);
}
