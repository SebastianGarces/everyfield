import { UserMultiple02Icon } from "@hugeicons/core-free-icons";
import {
	buttonVariants,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	EmptyState,
	IntentLink,
} from "@everyfield/ui/controls";
import { Avatar } from "@everyfield/ui/display";
import { cn } from "@everyfield/ui/foundations";
import { pairHref } from "./model.ts";
import type { DuplicatePairs as Pairs } from "./server.ts";

/**
 * The pairs to review at /people/duplicates (REQ-PPL-018): each person a CSV import added with "Add, review later" and
 * the person they may duplicate. Review opens the side-by-side review. A pair leaves once either person is merged or
 * retired. With none, a plain empty state.
 */
export function DuplicatePairs({ pairs }: { pairs: Pairs }) {
	if (!pairs.items.length)
		return (
			<Card>
				<EmptyState
					icon={UserMultiple02Icon}
					title="Nothing to review"
					headingLevel="h2"
					action={
						<IntentLink href="/people" className={buttonVariants({ variant: "primary" })}>
							Back to People
						</IntentLink>
					}
				>
					People an import added with &ldquo;Add, review later&rdquo; show here until you merge or retire them.
				</EmptyState>
			</Card>
		);
	const count = pairs.items.length;
	return (
		<Card as="section" aria-labelledby="pairs-title">
			<CardHeader className="mb-1">
				<CardHeading>
					<CardTitle as="h2" id="pairs-title">
						{pairs.completeness === "partial" ? `First ${count} to review` : `${count} to review`}
					</CardTitle>
					<CardDescription>
						Added by an import with &ldquo;Add, review later&rdquo;. Each pair stays until you merge them or retire one.
					</CardDescription>
				</CardHeading>
			</CardHeader>
			<ul className="flex flex-col">
				{pairs.items.map((p) => (
					<li key={p.person.id} className="flex items-center gap-3 border-t border-line py-3 first:border-t-0">
						<Avatar name={p.person.displayName} size="sm" decorative />
						<div className="min-w-0 flex-1">
							<p className="truncate font-medium text-ink">{p.person.displayName}</p>
							<p className="truncate text-sm text-text-3">May be {p.with.displayName}</p>
						</div>
						<IntentLink
							href={pairHref(p.person.id, p.with.id)}
							aria-label={`Review ${p.person.displayName} and ${p.with.displayName}`}
							className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "flex-none")}
						>
							Review
						</IntentLink>
					</li>
				))}
			</ul>
		</Card>
	);
}
