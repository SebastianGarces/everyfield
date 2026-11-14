"use client";

import type { ResidentReadingResult } from "@everyfield/contracts/organizations";
import { BookOpen01Icon } from "@hugeicons/core-free-icons";
import { Button, Card, EmptyState, PageHeader } from "@everyfield/ui/controls";
import Link from "next/link";
import { ArticleBody } from "../wiki/prose";
import { MY_RESIDENCY_PATH } from "./model";

/**
 * One church-owned article on the resident's reading list (REQ-MUL-013). It opens only from that list; the church's
 * other articles stay out of reach. An article the church no longer publishes reads as unavailable.
 */
export function ResidentReadingScreen({ reading }: { reading: ResidentReadingResult }) {
	const crumbs = [{ label: "My residency", href: MY_RESIDENCY_PATH }];
	if (reading.status === "unavailable")
		return (
			<div className="flex flex-col gap-5">
				<PageHeader breadcrumb={[...crumbs, { label: "Reading" }]} title="Reading" />
				<Card>
					<EmptyState
						icon={BookOpen01Icon}
						headingLevel="h2"
						title="This reading isn’t available"
						action={
							<Button asChild variant="primary">
								<Link href={MY_RESIDENCY_PATH}>Back to My residency</Link>
							</Button>
						}
					>
						Your sending church no longer publishes it, or it’s no longer on your reading list.
					</EmptyState>
				</Card>
			</div>
		);
	return (
		<div className="flex flex-col gap-5">
			<PageHeader
				breadcrumb={[...crumbs, { label: reading.title }]}
				title={reading.title}
				subtitle={`${reading.organizationName}’s version, on your reading list`}
			/>
			<Card className="mx-auto w-full max-w-[760px]">
				<ArticleBody contentType={reading.contentType} body={reading.body} />
			</Card>
		</div>
	);
}
