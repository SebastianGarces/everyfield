import type { ReactNode } from "react";
import { cn, Wordmark } from "../foundations";
import { initials } from "./Badges";
import type { Tone } from "./tone";

/**
 * Email (components.md, Email layout): Brand, Card, Heading, Meta box, Buttons (RSVP), List, Stats, Signature and
 * Footer (address, preferences); from church or Everyfield. Emails always use the light palette, a 600px column and
 * plain structure (.ef-paper in display.css keeps them light inside a dark page).
 *
 * These components draw an email inside the product: the composer preview, "View email" in history and design
 * review. The HTML that is sent (inline styles, tables for Outlook) is rendered by the email delivery owner from the
 * same parts and copy; see the WP-090 decisions.
 */

export type EmailFrom = { kind: "everyfield" } | { kind: "church"; name: string };

export function EmailLayout({
	from,
	envelope,
	footer,
	width = "desktop",
	children,
	className,
}: {
	from: EmailFrom;
	/** The mail client's header: sender, recipient and subject. */
	envelope?: { from: string; to: string; subject: string };
	footer: { reason: ReactNode; address: string; preferencesHref: string; unsubscribeHref: string };
	/** desktop is the 600px column; phone is 375px. */
	width?: "desktop" | "phone";
	children: ReactNode;
	className?: string;
}) {
	return (
		<article
			aria-label={envelope ? `Email: ${envelope.subject}` : "Email"}
			className={cn(
				"ef-paper @container mx-auto max-w-full overflow-hidden rounded-[14px] bg-cream font-body text-ink shadow-raised transition-[width] duration-250 motion-reduce:transition-none",
				width === "desktop" ? "w-[600px]" : "w-[375px]",
				className,
			)}
		>
			{envelope ? (
				<div className="flex flex-col gap-0.5 border-b border-line bg-surface-raised px-4 py-3 text-[12.5px] text-text-2">
					<span>
						<b className="font-semibold text-ink">{envelope.from}</b>
					</span>
					<span>To: {envelope.to}</span>
					<span>
						Subject: <b className="font-semibold text-ink">{envelope.subject}</b>
					</span>
				</div>
			) : null}
			<div className="px-[18px] pt-[22px] pb-[26px]">
				<div className="flex items-center gap-2.5 px-1.5 pt-1 pb-4">
					{from.kind === "everyfield" ? (
						<span className="text-ink">
							<Wordmark className="h-5 w-auto" />
							<span className="sr-only">Everyfield</span>
						</span>
					) : (
						<>
							<span
								aria-hidden="true"
								className="grid size-[34px] place-items-center rounded-[10px] bg-ink text-[13px] font-bold text-cream"
							>
								{initials(from.name)}
							</span>
							<span className="text-[15px] font-semibold">{from.name}</span>
						</>
					)}
				</div>
				<div className="rounded-[16px] bg-surface-raised px-[30px] pt-[30px] pb-7 @max-[480px]:px-5 @max-[480px]:py-6">
					{children}
				</div>
				<footer className="px-2.5 pt-[18px] text-center text-[12.5px] leading-[1.6] text-text-3">
					{footer.reason}
					<br />
					{footer.address}
					<br />
					<a href={footer.preferencesHref} className="text-text-2 underline">
						Email preferences
					</a>
					{" · "}
					<a href={footer.unsubscribeHref} className="text-text-2 underline">
						Unsubscribe
					</a>
				</footer>
			</div>
		</article>
	);
}

/** The email's one heading. */
export function EmailHeading({ children }: { children: ReactNode }) {
	return (
		<h1 className="mb-3 font-display text-[28px] leading-[1.15] font-medium tracking-[-0.02em] text-ink @max-[480px]:text-2xl">
			{children}
		</h1>
	);
}

/** A paragraph. `lead` is the larger opening line ("Hi Maria,"); `small` is a quiet note. */
export function EmailText({ lead, small, children }: { lead?: boolean; small?: boolean; children: ReactNode }) {
	return (
		<p
			className={cn(
				"mb-3.5 leading-[1.6]",
				lead ? "text-[17px] text-ink" : small ? "text-sm text-text-2" : "text-base text-ink-2",
			)}
		>
			{children}
		</p>
	);
}

/** The buttons row. They stack full width in a phone-width email. */
export function EmailButtons({ children }: { children: ReactNode }) {
	return <div className="mt-[18px] mb-1.5 flex flex-wrap gap-2 @max-[480px]:flex-col">{children}</div>;
}

/**
 * An email button is a link. variant="yes" is the RSVP yes in brand green; "alt" is the quiet choice (Maybe, Change my
 * answer). Text on the green fill is ink, never white.
 */
export function EmailButton({
	href,
	variant = "primary",
	children,
}: {
	href: string;
	variant?: "primary" | "yes" | "alt";
	children: ReactNode;
}) {
	return (
		<a
			href={href}
			className={cn(
				"inline-block rounded-[12px] px-[22px] py-[13px] text-[15px] font-semibold no-underline @max-[480px]:text-center",
				variant === "primary" && "bg-ink text-on-ink",
				variant === "yes" && "bg-green text-ink",
				variant === "alt" && "bg-surface-2 text-ink",
			)}
		>
			{children}
		</a>
	);
}

/** The meta box: When, Where, Host. */
export function EmailMeta({ rows }: { rows: { label: string; value: ReactNode }[] }) {
	return (
		<dl className="my-4 rounded-[12px] bg-cream/60 px-4 py-3.5 text-[15px] leading-[1.55]">
			{rows.map((r) => (
				<div key={r.label} className="flex gap-2.5">
					<dt className="min-w-[52px] text-text-2">{r.label}</dt>
					<dd className="font-semibold text-ink">{r.value}</dd>
				</div>
			))}
		</dl>
	);
}

const EMAIL_TINT: Partial<Record<Tone, string>> = {
	blue: "bg-blue-100 text-blue-600",
	green: "bg-green-100 text-green-700",
	violet: "bg-violet-100 text-violet-600",
	magenta: "bg-magenta-100 text-magenta-600",
};

/** A list of people or dates, each with a round badge, a line and an optional magenta tag ("22 h late"). */
export function EmailList({
	items,
}: {
	items: { badge: string; text: ReactNode; tag?: string; tone?: "blue" | "green" | "violet" }[];
}) {
	return (
		<ul className="mt-2 mb-4">
			{items.map((item, i) => (
				<li key={i} className="flex items-center gap-3 border-t border-line py-2.5 text-[15px] first:border-t-0">
					<span
						aria-hidden="true"
						className={cn(
							"grid size-[30px] flex-none place-items-center rounded-full text-[11px] font-bold",
							EMAIL_TINT[item.tone ?? "blue"],
						)}
					>
						{item.badge}
					</span>
					<span className="min-w-0 flex-1">{item.text}</span>
					{item.tag ? (
						<span className="rounded-full bg-magenta-100 px-2 py-[3px] text-xs font-semibold whitespace-nowrap text-magenta-600">
							{item.tag}
						</span>
					) : null}
				</li>
			))}
		</ul>
	);
}

/**
 * Stats: up to three numbers. A number that failed to load is left out by the caller, never sent as zero (Weekly
 * digest).
 */
export function EmailStats({ stats }: { stats: { value: string; label: string }[] }) {
	return (
		<dl className="mt-3.5 mb-[18px] grid grid-cols-3 gap-2 @max-[480px]:grid-cols-2">
			{stats.map((s) => (
				<div key={s.label} className="flex flex-col-reverse rounded-[12px] bg-cream/60 px-3.5 py-3">
					<dt className="text-[13px] text-text-2">{s.label}</dt>
					<dd className="font-display text-[26px] font-medium text-ink">{s.value}</dd>
				</div>
			))}
		</dl>
	);
}

/** The sender's signature: initials, name and role. */
export function EmailSignature({ name, role }: { name: string; role: string }) {
	return (
		<div className="mt-[18px] flex items-center gap-3">
			<span
				aria-hidden="true"
				className="grid size-10 flex-none place-items-center rounded-full bg-green-100 font-bold text-green-700"
			>
				{initials(name)}
			</span>
			<div>
				<b className="font-semibold">{name}</b>
				<div className="text-sm text-text-2">{role}</div>
			</div>
		</div>
	);
}

/** "Evry noticed": a note with the small drawn Evry (two eyes on green; no animation in email). */
export function EmailNote({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-start gap-2.5 rounded-[12px] bg-violet-100 px-3.5 py-3 text-[14.5px] leading-[1.5] text-ink-2">
			<span
				aria-hidden="true"
				className="mt-px inline-flex size-[22px] flex-none items-center justify-center gap-[3px] rounded-full bg-green"
			>
				<i className="block h-1.5 w-[3px] rounded-[2px] bg-ink" />
				<i className="block h-1.5 w-[3px] rounded-[2px] bg-ink" />
			</span>
			<span>{children}</span>
		</div>
	);
}
