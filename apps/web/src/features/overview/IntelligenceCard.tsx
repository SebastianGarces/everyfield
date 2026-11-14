import type { AssessmentView } from "@everyfield/contracts/intelligence";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import {
	buttonVariants,
	Card,
	CardActions,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	IntentLink,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { coldStartTitle, dayText, QUALITY, SEVERITY_LABEL, STANDING } from "../intelligence/assessment-model.ts";
import { CardFailed } from "./cards.tsx";
import type { Loaded } from "./model.ts";

/**
 * Overview's Plant Intelligence card (WP-044): the same main focus and eight lens tiles as /intelligence, from the same
 * saved assessment, each linking to it. Before the first assessment it says so, never an empty "all good".
 */
export function IntelligenceCard({ loaded }: { loaded: Loaded<AssessmentView> }) {
	if (loaded.status !== "ok") return <CardFailed what="Plant Intelligence" loaded={loaded} />;
	const a = loaded.value.current;
	if (!a) {
		const { title, body } = coldStartTitle(loaded.value.newest);
		return (
			<Card as="section" aria-labelledby="overview-intelligence">
				<CardHeader>
					<CardHeading>
						<CardTitle id="overview-intelligence">Plant Intelligence</CardTitle>
						<CardDescription>{title}</CardDescription>
					</CardHeading>
				</CardHeader>
				<p className="text-md text-text-2">{body}</p>
				<div className="mt-4">
					<IntentLink href="/intelligence" className={buttonVariants({ variant: "secondary", size: "sm" })}>
						Open Plant Intelligence
						<Icon icon={ArrowRight01Icon} size={16} />
					</IntentLink>
				</div>
			</Card>
		);
	}
	return (
		<Card as="section" aria-labelledby="overview-intelligence" data-run={a.runId}>
			<CardHeader>
				<CardHeading>
					<CardTitle id="overview-intelligence">Plant Intelligence</CardTitle>
					<CardDescription>
						Phase {a.phase} assessment, measured {dayText(a.measuredOn)}
					</CardDescription>
				</CardHeading>
				<CardActions>
					<IntentLink href="/intelligence" className={buttonVariants({ variant: "ghost", size: "sm" })}>
						Open
						<Icon icon={ArrowRight01Icon} size={16} />
					</IntentLink>
				</CardActions>
			</CardHeader>
			<IntentLink
				href="/intelligence#focus"
				data-focus
				className="block cursor-pointer rounded-md bg-surface-2 px-4 py-3.5 transition-colors hover:bg-surface-3"
			>
				<span className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-3">
					<span className="font-medium text-ink-2">Main focus</span>
					<span>{SEVERITY_LABEL[a.focus.severity]}</span>
				</span>
				<span className="mt-1.5 block font-title text-[19px] leading-snug text-ink text-balance">{a.focus.title}</span>
			</IntentLink>
			<ul aria-label="Eight critical success factors" className="mt-4 grid grid-cols-4 gap-2.5 max-app-lg:grid-cols-2">
				{a.lenses.map((l) => {
					const standing = STANDING[l.standing];
					return (
						<li key={l.key}>
							<IntentLink
								href={`/intelligence#lens-${l.key}`}
								data-lens={l.key}
								data-quality={l.quality}
								data-standing={l.standing}
								className={cn(
									"flex h-full cursor-pointer flex-col gap-2 rounded-md px-3 py-2.5 transition-colors",
									l.quality === "unknown"
										? "border-[1.5px] border-dashed border-line-2 hover:bg-hover"
										: "bg-surface-2 hover:bg-surface-3",
								)}
							>
								<span className="text-sm font-medium text-ink">{l.label}</span>
								<span className="mt-auto flex flex-wrap items-center justify-between gap-1.5">
									<StatusBadge size="sm" status={standing.status}>
										{standing.label}
									</StatusBadge>
									<span className="text-xs text-text-3">{QUALITY[l.quality].label}</span>
								</span>
							</IntentLink>
						</li>
					);
				})}
			</ul>
		</Card>
	);
}
