"use client";

import { buttonVariants, Card, CardHeader, CardHeading, CardTitle, IntentLink } from "@everyfield/ui/controls";
import { Avatar } from "@everyfield/ui/display";
import { cn } from "@everyfield/ui/foundations";
import { listText, pairHref } from "./model.ts";
import type { DuplicateHints as Hints } from "./server.ts";

/**
 * Possible duplicates of this person (REQ-PPL-016): people who share a normalized email or phone, or the same name.
 * Hints only, never proof of identity. Owners and Admins open the side-by-side review from here; Members see the hint
 * and the other person's page. Nothing shows when there is no hint.
 */
export function DuplicateHints({ personId, hints, canReview }: { personId: string; hints: Hints; canReview: boolean }) {
	if (!hints.items.length) return null;
	return (
		<Card as="section" aria-labelledby="duplicates-title">
			<CardHeader className="mb-1">
				<CardHeading>
					<CardTitle size="sm" id="duplicates-title">
						{hints.items.length === 1 ? "Possible duplicate" : "Possible duplicates"}
					</CardTitle>
				</CardHeading>
			</CardHeader>
			<ul className="flex flex-col">
				{hints.items.map((h) => (
					<li key={h.personId} className="flex items-center gap-3 border-t border-line py-3 first:border-t-0">
						<Avatar name={h.displayName} size="sm" decorative />
						<div className="min-w-0 flex-1">
							<IntentLink
								href={`/people/${h.personId}`}
								className="block truncate font-medium text-ink underline-offset-2 hover:underline"
							>
								{h.displayName}
							</IntentLink>
							<p className="text-sm text-text-3">Same {listText(h.signals)}</p>
						</div>
						{canReview ? (
							<IntentLink
								href={pairHref(personId, h.personId)}
								aria-label={`Review ${h.displayName} as a possible duplicate`}
								className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "flex-none")}
							>
								Review
							</IntentLink>
						) : null}
					</li>
				))}
			</ul>
			<p className="mt-2 text-xs text-text-3">
				{hints.completeness === "partial" ? "The first 25 hints. " : null}A hint is not proof. Everyfield never merges
				on its own.
			</p>
		</Card>
	);
}
