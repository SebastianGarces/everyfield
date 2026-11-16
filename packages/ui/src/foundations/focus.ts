"use client";

import { useState } from "react";

const FIELD = 'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)';

export function firstField(scope: ParentNode): HTMLElement | null {
	const invalid = scope.querySelector<HTMLElement>('[aria-invalid="true"]');
	if (invalid) return invalid;
	const first = scope.querySelector<HTMLElement>(FIELD);
	if (!(first instanceof HTMLInputElement) || first.type !== "radio" || !first.name) return first;
	return scope.querySelector<HTMLElement>(`input[type="radio"][name="${CSS.escape(first.name)}"]:checked`) ?? first;
}

export function focusIfLost<T extends HTMLElement>(node: T): T | null {
	const active = node.ownerDocument.activeElement;
	return active === null || active === node.ownerDocument.body ? node : null;
}

export function focusOnMount(node: HTMLElement | null): void {
	node?.focus();
}

export function focusFirstField(node: HTMLElement | null): void {
	if (node) firstField(node)?.focus();
}

export type FocusRequest = string | number | false | null | undefined;
export type FocusPick<T extends HTMLElement> = (node: T) => HTMLElement | null;

const isRequest = (request: FocusRequest) =>
	request !== null && request !== undefined && request !== false && request !== 0 && request !== "";

export function createFocusRequests() {
	let served: FocusRequest;
	let last: {
		request: FocusRequest;
		pick: unknown;
		options: string;
		ref: (node: HTMLElement | null) => void;
	} | null = null;
	return {
		ref<T extends HTMLElement>(
			request: FocusRequest,
			pick?: FocusPick<T>,
			options?: FocusOptions,
		): (node: T | null) => void {
			const key = `${options?.preventScroll}/${options?.focusVisible}`;
			if (last && last.request === request && last.pick === pick && last.options === key) return last.ref;
			const ref = (node: T | null) => {
				if (!node || !isRequest(request) || served === request) return;
				served = request;
				(pick ? pick(node) : node)?.focus(options);
			};
			last = { request, pick, options: key, ref: ref as (node: HTMLElement | null) => void };
			return ref;
		},
	};
}

export function useFocusRequest<T extends HTMLElement>(
	request: FocusRequest,
	pick?: FocusPick<T>,
	options?: FocusOptions,
): (node: T | null) => void {
	const [requests] = useState(createFocusRequests);
	return requests.ref(request, pick, options);
}

export function useFocusOnChange<T extends HTMLElement>(
	value: string | number | boolean | null | undefined,
	pick?: FocusPick<T>,
	options?: FocusOptions,
): (node: T | null) => void {
	const [seen, setSeen] = useState({ value, changes: 0 });
	if (!Object.is(seen.value, value)) setSeen({ value, changes: seen.changes + 1 });
	return useFocusRequest(seen.changes, pick, options);
}
