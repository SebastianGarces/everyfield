"use client";

import { useState } from "react";
import { PageHeader, SegmentedControl } from "../../controls";
import { ContentSection, ProseSizesSection } from "./PreviewContent";
import { BadgesSection, ListsSection, PhotoSection, TableSection } from "./PreviewData";
import { PipelineSection } from "./PreviewPipeline";

type Group = "all" | "data" | "content" | "domain";

const GROUPS = [
	{ value: "all", label: "All" },
	{ value: "data", label: "Data" },
	{ value: "content", label: "Content" },
	{ value: "domain", label: "Domain" },
] as const satisfies readonly { value: Group; label: string }[];

export function DisplayPreview() {
	const [group, setGroup] = useState<Group>("all");
	const show = (g: Group) => group === "all" || group === g;
	return (
		<>
			<PageHeader
				size="xl"
				breadcrumb={[{ label: "Design system", href: "/design/foundations" }, { label: "Display" }]}
				title="Display"
				subtitle="Shared data, content and domain parts. Feature pages compose their screens from them and keep their own data and rules. The sample data is invented."
				actions={<SegmentedControl label="Show group" options={[...GROUPS]} value={group} onValueChange={setGroup} />}
				className="reveal"
			/>
			<div className="flex flex-col gap-12">
				{show("data") ? <BadgesSection index={1} /> : null}
				{show("data") ? <ListsSection index={2} /> : null}
				{show("data") ? <TableSection index={3} /> : null}
				{show("content") ? <ContentSection index={4} /> : null}
				{show("domain") ? <PipelineSection index={5} /> : null}
				{show("data") ? <PhotoSection index={6} /> : null}
				{show("content") ? <ProseSizesSection index={7} /> : null}
			</div>
		</>
	);
}
