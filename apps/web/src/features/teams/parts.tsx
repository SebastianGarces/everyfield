"use client";

import { ArrowRight01Icon, UserAdd01Icon } from "@hugeicons/core-free-icons";
import { CardIcon, IntentLink } from "@everyfield/ui/controls";
import { Avatar, StatusBadge } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { ICONS, iconKey, plural, teamBadge, type Team } from "./model.ts";

/** The ministry's icon tile, in its icon's tone. Decorative: the name is always written next to it. */
export function TeamIcon({ team, size = 44 }: { team: Pick<Team, "icon" | "templateKey">; size?: 36 | 44 }) {
	const i = ICONS[iconKey(team)];
	return <CardIcon icon={i.icon} tone={i.tone} size={size} />;
}

export function TeamBadge({ team, size }: { team: Pick<Team, "archived" | "state">; size?: "sm" | "md" }) {
	const b = teamBadge(team);
	return (
		<StatusBadge status={b.status} size={size}>
			{b.label}
		</StatusBadge>
	);
}

/** The leader, or a dashed empty seat that says a leader is needed. The words carry the meaning, not the color. */
export function LeaderLine({ name, className }: { name: string | null; className?: string }) {
	return (
		<p className={cn("flex min-w-0 items-center gap-2 text-sm", className)}>
			{name ? (
				<>
					<Avatar name={name} size="xs" decorative />
					<span className="truncate text-text-2">
						<span className="sr-only">Leader: </span>
						{name}
					</span>
				</>
			) : (
				<>
					<Avatar name="" size="xs" decorative className="bg-transparent shadow-[inset_0_0_0_1.5px_var(--ef-line-2)]">
						<Icon icon={UserAdd01Icon} size={16} className="text-text-3" />
					</Avatar>
					<span className="font-medium text-magenta-600">Leader needed</span>
				</>
			)}
		</p>
	);
}

/**
 * One ministry on the list: icon, state, name, leader and how many serve. The whole card is one link named by the
 * ministry, so a voice-control user can say what they see (WCAG 2.5.3). It prefetches on intent only.
 */
export function MinistryCard({ team }: { team: Team & { leaderName: string | null } }) {
	// The name comes first in reading order, so the link is named by the ministry; the icon and state row is drawn
	// above it with `order`.
	return (
		<IntentLink
			href={`/ministries/${team.id}`}
			className="group flex w-full flex-col rounded-card border border-[var(--ef-card-edge)] bg-surface p-5 shadow-card transition-shadow duration-150 hover:shadow-raised focus-visible:shadow-[0_0_0_2px_var(--ef-ink)] focus-visible:outline-none"
		>
			<span className="order-2 mt-4 flex items-center gap-1.5">
				<span className="min-w-0 font-title text-title-sm tracking-[-0.01em] wrap-anywhere text-ink">{team.name}</span>
				<Icon
					icon={ArrowRight01Icon}
					size={16}
					className="flex-none text-text-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
				/>
			</span>
			<span className="order-1 flex items-start justify-between gap-3">
				<TeamIcon team={team} />
				<TeamBadge team={team} size="sm" />
			</span>
			<LeaderLine name={team.leaderName} className="order-3 mt-2 mb-4" />
			<span className="order-4 mt-auto flex items-center justify-between border-t border-line pt-3 text-sm">
				<span className="text-text-3">Serving</span>
				<b className="font-semibold text-ink tabular-nums">{plural(team.activeCount, "person", "people")}</b>
			</span>
		</IntentLink>
	);
}
