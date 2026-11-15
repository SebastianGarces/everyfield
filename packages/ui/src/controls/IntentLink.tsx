"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps, FocusEvent, PointerEvent, TouchEvent } from "react";

type IntentHandlers = {
	onPointerEnter: (e: PointerEvent<HTMLAnchorElement>) => void;
	onTouchStart: (e: TouchEvent<HTMLAnchorElement>) => void;
	onFocus: (e: FocusEvent<HTMLAnchorElement>) => void;
};

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

export function both<E>(a?: (e: E) => void, b?: (e: E) => void) {
	return (e: E) => {
		a?.(e);
		b?.(e);
	};
}

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
