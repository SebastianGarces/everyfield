"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps, FocusEvent, PointerEvent, TouchEvent } from "react";

type IntentHandlers = {
	onPointerEnter: (e: PointerEvent<HTMLAnchorElement>) => void;
	onTouchStart: (e: TouchEvent<HTMLAnchorElement>) => void;
	onFocus: (e: FocusEvent<HTMLAnchorElement>) => void;
};

/**
 * Prefetch a route when a person shows intent: a mouse moves over the link, a finger touches it, or keyboard focus
 * reaches it. Spread on a link that has `prefetch={false}`, so scrolling into view sends nothing. `enabled` false
 * returns handlers that do nothing, for links that should never prefetch.
 */
export function useIntentPrefetch(href: string, enabled = true): IntentHandlers {
	const router = useRouter();
	const warm = () => {
		if (enabled) router.prefetch(href);
	};
	return {
		onPointerEnter: (e) => {
			if (e.pointerType === "mouse") warm();
		},
		onTouchStart: warm,
		onFocus: (e) => {
			if (e.currentTarget.matches(":focus-visible")) warm();
		},
	};
}

/** Runs each handler in turn, so a link can carry both the hover highlight and the intent prefetch. */
export function both<E>(a?: (e: E) => void, b?: (e: E) => void) {
	return (e: E) => {
		a?.(e);
		b?.(e);
	};
}

/** A next/link that prefetches on intent only (see useIntentPrefetch). */
export function IntentLink({
	href,
	...props
}: Omit<ComponentProps<typeof Link>, "href" | "prefetch"> & { href: string }) {
	const intent = useIntentPrefetch(href);
	return (
		<Link
			{...props}
			href={href}
			prefetch={false}
			onPointerEnter={both(props.onPointerEnter, intent.onPointerEnter)}
			onTouchStart={both(props.onTouchStart, intent.onTouchStart)}
			onFocus={both(props.onFocus, intent.onFocus)}
		/>
	);
}
