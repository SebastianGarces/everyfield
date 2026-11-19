"use client";

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { Icon, useHydrated } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useSyncExternalStore, type ComponentProps } from "react";
import type * as people from "@everyfield/contracts/people";
import type { z } from "zod";
import { statusWarnings } from "./fetch.ts";
import type { Outcome } from "../../components/save/model.ts";
import { createRead, useRead } from "../../components/read.tsx";
import { useLocalStore } from "../../components/store.ts";
import { createPersonStore, withServer, type PersonState, type PersonStore, type Saved } from "./person.store.ts";

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

export function usePersonStore<P extends Saved & { id: string }, D>(person: P): [PersonStore<P, D>, PersonState<P, D>] {
	const own = useLocalStore(() => createPersonStore<P, D>(person));
	const store = useMemo(() => withServer(own, person), [own, person]);
	return [store, usePersonState(store)];
}

export function usePersonState<P extends Saved, D>(store: PersonStore<P, D>): PersonState<P, D> {
	return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export const fresh = () => crypto.randomUUID();
export const isConflict = <T,>(o: Outcome<T> | null) => o?.status === "refused" && o.code === "conflict";
export const problemOf = <T,>(o: Outcome<T> | null): string | undefined =>
	!o || o.status === "ok" ? undefined : o.status === "lost" ? "lost" : o.code;

const DATE = { month: "short", day: "numeric", year: "numeric" } as const;
const TIME = { ...DATE, hour: "numeric", minute: "2-digit" } as const;
const DAY = new Intl.DateTimeFormat("en-US", { ...DATE, timeZone: "UTC" });
export function When({ at, withTime = false }: { at: string; withTime?: boolean }) {
	const browser = useHydrated();
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", { ...(withTime ? TIME : DATE), ...(browser ? {} : { timeZone: "UTC" }) })
			.formatToParts(new Date(at))
			.map((p) => [p.type, p.value]),
	);
	const text = `${parts.month} ${parts.day}, ${parts.year}${withTime ? `, ${parts.hour}:${parts.minute} ${parts.dayPeriod}` : ""}`;
	return <time dateTime={at}>{text}</time>;
}
export function LocalDay({ day }: { day: string }) {
	const [y, m, d] = day.split("-").map(Number) as [number, number, number];
	return <time dateTime={day}>{DAY.format(new Date(Date.UTC(y, m - 1, d)))}</time>;
}

type Warnings = Outcome<z.infer<typeof people.statusWarningsResult>>;
const warningsRead = createRead<[personId: string, round: number], Warnings>((personId) => statusWarnings(personId), {
	failed: () => ({ status: "lost" }) as const,
});

export const prefetchWarnings = (personId: string) => warningsRead.prefetch(personId, 0);

export function useWarnings(personId: string, round: number): Warnings | null {
	return useRead(warningsRead, personId, round).value ?? null;
}

export function CardLink({ className, ...props }: ComponentProps<typeof PersonLink>) {
	return (
		<PersonLink {...props} className={`${className ?? ""} inline-block max-w-full truncate align-top leading-6`} />
	);
}

export function PersonLink({
	href,
	onPointerMove,
	onTouchStart,
	onFocus,
	...props
}: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
	const router = useRouter();
	const warm = () => router.prefetch(href);
	return (
		<Link
			{...props}
			href={href}
			prefetch={false}
			onPointerMove={(e) => {
				if (e.pointerType === "mouse") warm();
				onPointerMove?.(e);
			}}
			onTouchStart={(e) => {
				warm();
				onTouchStart?.(e);
			}}
			onFocus={(e) => {
				if (e.currentTarget.matches(":focus-visible")) warm();
				onFocus?.(e);
			}}
		/>
	);
}
