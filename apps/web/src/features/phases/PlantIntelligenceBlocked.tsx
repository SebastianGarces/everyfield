import { LockKeyIcon } from "@hugeicons/core-free-icons";
import { Card, PageHeader, StatePanel } from "@everyfield/ui/controls";

export function PlantIntelligenceBlocked({
	title,
	tone = "lock",
	children,
}: {
	title: string;
	tone?: "lock" | "error";
	children: React.ReactNode;
}) {
	return (
		<>
			<PageHeader size="xl" title="Plant Intelligence" />
			<Card>
				<StatePanel tone={tone} icon={tone === "lock" ? LockKeyIcon : undefined} title={title} headingLevel="h2">
					{children}
				</StatePanel>
			</Card>
		</>
	);
}

export function NoChurchPlantSeat() {
	return (
		<PlantIntelligenceBlocked title="Plant Intelligence belongs to a church plant">
			Your account has no current seat in a church plant, so there is no journey to show here.
		</PlantIntelligenceBlocked>
	);
}
