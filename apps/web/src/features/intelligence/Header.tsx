import { LockKeyIcon } from "@hugeicons/core-free-icons";
import { PageHeader } from "@everyfield/ui/controls";
import { Icon } from "@everyfield/ui/foundations";

/** The check-in page title: who it is for and the "Only you" mark (prototype #/me/check-in). */
export function CheckInHeader({ name, subtitle }: { name: string; subtitle: string }) {
	const first = name.trim().split(/\s+/)[0];
	return (
		<PageHeader
			size="xl"
			breadcrumb={[{ label: name || "You" }, { label: "Weekly check-in" }]}
			title={
				<span className="inline-flex flex-wrap items-center gap-x-4 gap-y-2">
					{first ? `How are you, ${first}?` : "How are you?"}
					<span className="inline-flex h-[30px] items-center gap-1.5 rounded-pill bg-violet-100 px-3 align-middle font-sans text-[13px] font-semibold tracking-normal text-violet-600">
						<Icon icon={LockKeyIcon} size={16} />
						Only you
					</span>
				</span>
			}
			subtitle={subtitle}
		/>
	);
}
