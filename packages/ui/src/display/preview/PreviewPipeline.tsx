"use client";

import { PersonCard, PipelineColumn, StatusBadge, Tag } from "..";
import { Section } from "./kit";

export function PipelineSection({ index }: { index: number }) {
	return (
		<Section
			index={index}
			title="Pipeline"
			code="<PipelineColumn stage count dropTarget> <PersonCard selected dragging>"
			note="The feature owns drag and drop and its keyboard alternative; these parts only draw the selected, dragging and drop-target looks. An empty column says so."
		>
			<div className="flex gap-4 overflow-x-auto pb-2">
				<PipelineColumn stage="interviewed" count={2}>
					<PersonCard
						name="Maria Santos"
						tone="blue"
						meta="Interviewed Sep 30"
						href="#maria"
						footer={
							<>
								<Tag tone="green">Worship</Tag>
								<StatusBadge status="positive" size="sm">
									Ready
								</StatusBadge>
							</>
						}
					/>
					<PersonCard
						name="David Kim"
						tone="amber"
						meta="Interviewed Sep 22"
						href="#david"
						selected
						footer={
							<>
								<span className="text-xs text-text-3">No ministry</span>
								<StatusBadge status="attention" size="sm">
									16 d
								</StatusBadge>
							</>
						}
					/>
				</PipelineColumn>
				<PipelineColumn stage="core" count={1} dropTarget>
					<PersonCard name="Ana Lee" tone="green" meta="Committed Oct 6" href="#ana" dragging />
				</PipelineColumn>
				<PipelineColumn stage="launch" count={0} />
			</div>
		</Section>
	);
}
