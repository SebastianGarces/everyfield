"use client";

import { useState } from "react";
import { PageHeader, SegmentedControl, ToastProvider } from "../../controls";
import { ChartsSection } from "./PreviewCharts";
import { ContentSection } from "./PreviewContent";
import { BadgesSection, StatsSection, TableSection } from "./PreviewData";
import { RecordsSection, WorkSection } from "./PreviewDomain";
import { EmailSection } from "./PreviewEmail";
import { EvrySection } from "./PreviewEvry";

type Group = "all" | "data" | "charts" | "content" | "domain" | "evry" | "email";

const GROUPS = [
	{ value: "all", label: "All" },
	{ value: "data", label: "Data" },
	{ value: "charts", label: "Charts" },
	{ value: "content", label: "Content" },
	{ value: "domain", label: "Domain" },
	{ value: "evry", label: "Evry" },
	{ value: "email", label: "Email" },
] as const satisfies readonly { value: Group; label: string }[];

/**
 * The display preview at /design/display, after the prototype's #/components page: every WP-090 inventory row in its
 * drawn states, with invented sample data. Every interactive part works, so keyboard, focus and the loading, error
 * and empty states can be checked in place.
 */
export function DisplayPreview() {
	const [group, setGroup] = useState<Group>("all");
	const show = (g: Group) => group === "all" || group === g;
	return (
		<ToastProvider>
			<PageHeader
				size="xl"
				breadcrumb={[{ label: "Design system", href: "/design/foundations" }, { label: "Display" }]}
				title="Display"
				subtitle="Shared data, chart, content, domain, Evry and email parts. Feature pages compose their screens from them and keep their own data and rules. The sample data is invented."
				actions={<SegmentedControl label="Show group" options={[...GROUPS]} value={group} onValueChange={setGroup} />}
				className="reveal"
			/>
			<div className="flex flex-col gap-12">
				{show("data") ? <BadgesSection index={1} /> : null}
				{show("data") ? <StatsSection index={2} /> : null}
				{show("data") ? <TableSection index={3} /> : null}
				{show("charts") ? <ChartsSection index={4} /> : null}
				{show("content") ? <ContentSection index={5} /> : null}
				{show("domain") ? <WorkSection index={6} /> : null}
				{show("domain") ? <RecordsSection index={7} /> : null}
				{show("evry") ? <EvrySection index={8} /> : null}
				{show("email") ? <EmailSection index={9} /> : null}
			</div>
		</ToastProvider>
	);
}
