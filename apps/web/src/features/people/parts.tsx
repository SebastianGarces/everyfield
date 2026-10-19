"use client";

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import type * as people from "@everyfield/contracts/people";
import type { z } from "zod";
import { statusWarnings } from "./actions.ts";
import type { Outcome } from "./model.ts";
import { PersonStore, type PersonState, type Saved } from "./model.ts";

/** What a refusal or lost answer means for the person, in words. Nothing here reveals another tenant's records. */
export function problemText(code: string): string {
	switch (code) {
		case "conflict":
			return "This person changed while you were working. Check the latest details, then try again.";
		case "lost":
			return "We did not hear back from the server. Your text is kept. Try again; it will not save twice.";
		case "use_reviewed_unmerge":
			return "This person was merged into another record. A merge is undone with a reviewed Unmerge, not Restore.";
		case "invalid_input":
			return "Some details are not valid. Check them and try again.";
		case "invalid_subject":
			return "That person cannot be chosen here.";
		case "source_unavailable":
			return "Some linked records could not be read. Try again in a moment.";
		case "unsupported_field":
			return "One of these details cannot be changed here.";
		default:
			return "You cannot make this change. Your seat may have changed; reload the page.";
	}
}

/** The error line under a form. It is a live region, so a screen reader hears the problem when it appears. */
export function FormProblem({ code, id }: { code: string | undefined; id?: string }) {
	return (
		<div aria-live="assertive" id={id} className="empty:hidden">
			{code ? (
				<p className="flex items-start gap-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600">
					<Icon icon={Alert02Icon} size={16} className="mt-px flex-none" />
					{problemText(code)}
				</p>
			) : null}
		</div>
	);
}

/** One store per person page. It survives dialogs opening and closing; the server props refresh it. */
export function usePersonStore<P extends Saved & { id: string }, D>(person: P): [PersonStore<P, D>, PersonState<P, D>] {
	// One store for this person on this page. Server props after a refresh update it; they never reset drafts.
	const store = useMemo(() => new PersonStore<P, D>(person), [person.id]); // eslint-disable-line react-hooks/exhaustive-deps
	const state = useSyncExternalStore(store.subscribe, store.get, store.get);
	useEffect(() => store.dispatch({ type: "server", person }), [store, person]);
	return [store, state];
}

/** The current state of a store, re-rendering on every change. */
export function useStore<P extends Saved, D>(store: PersonStore<P, D>): PersonState<P, D> {
	return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export const fresh = () => crypto.randomUUID();
export const isOk = <T,>(o: Outcome<T> | null): o is { status: "ok"; value: T } => o?.status === "ok";
export const problemOf = <T,>(o: Outcome<T> | null): string | undefined =>
	!o || o.status === "ok" ? undefined : o.status === "lost" ? "lost" : o.code;

const DATE = { month: "short", day: "numeric", year: "numeric" } as const;
const TIME = { ...DATE, hour: "numeric", minute: "2-digit" } as const;
const DAY = new Intl.DateTimeFormat("en-US", { ...DATE, timeZone: "UTC" });
const noSubscribe = () => () => {};
/**
 * An instant in the reader's own time zone. The server and the first browser render use UTC, so hydration matches; right after it the browser shows the reader's zone.
 */
export function When({ at, withTime = false }: { at: string; withTime?: boolean }) {
	const browser = useSyncExternalStore(
		noSubscribe,
		() => true,
		() => false,
	);
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", { ...(withTime ? TIME : DATE), ...(browser ? {} : { timeZone: "UTC" }) })
			.formatToParts(new Date(at))
			.map((p) => [p.type, p.value]),
	);
	// The punctuation is ours: engines join the same parts differently ("Oct 19, 2026, 1:30 AM" or "... at 1:30 AM"),
	// which would break hydration.
	const text = `${parts.month} ${parts.day}, ${parts.year}${withTime ? `, ${parts.hour}:${parts.minute} ${parts.dayPeriod}` : ""}`;
	return <time dateTime={at}>{text}</time>;
}
/** A calendar date (yyyy-mm-dd) shown as written, never shifted by a time zone. */
export function LocalDay({ day }: { day: string }) {
	const [y, m, d] = day.split("-").map(Number) as [number, number, number];
	return <time dateTime={day}>{DAY.format(new Date(Date.UTC(y, m - 1, d)))}</time>;
}

export function SectionNote({ children }: { children: ReactNode }) {
	return <p className="text-sm text-text-3">{children}</p>;
}

/**
 * The person's status warnings, open duties and review revision, read when a dialog opens and again whenever the
 * person's revision changes. Null while loading. Dialogs mount when they open, so every opening reads afresh.
 */
export function useWarnings(
	personId: string,
	revision: string,
): Outcome<z.infer<typeof people.statusWarningsResult>> | null {
	const key = `${personId}:${revision}`;
	const [got, setGot] = useState<{ key: string; value: Outcome<z.infer<typeof people.statusWarningsResult>> } | null>(
		null,
	);
	useEffect(() => {
		let live = true;
		statusWarnings(personId).then(
			(value) => live && setGot({ key, value }),
			() => live && setGot({ key, value: { status: "lost" } }),
		);
		return () => {
			live = false;
		};
	}, [key, personId]);
	return got?.key === key ? got.value : null;
}

/**
 * The name link inside a PersonCard. PersonCard passes its own classes (the stretched link that makes the whole card
 * clickable); this sets a 24px line, so the link itself meets the WCAG 2.2 target size next to the card's Move button,
 * and keeps the ellipsis on a long name.
 */
export function CardLink({ className, ...props }: ComponentProps<typeof Link>) {
	return <Link {...props} className={`${className ?? ""} inline-block max-w-full truncate align-top leading-6`} />;
}
