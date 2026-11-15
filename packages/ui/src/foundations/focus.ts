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
	let last: { request: FocusRequest; pick: unknown; ref: (node: HTMLElement | null) => void } | null = null;
	return {
		ref<T extends HTMLElement>(request: FocusRequest, pick?: FocusPick<T>): (node: T | null) => void {
			if (last && last.request === request && last.pick === pick) return last.ref;
			const ref = (node: T | null) => {
				if (!node || !isRequest(request) || served === request) return;
				served = request;
				(pick ? pick(node) : node)?.focus();
			};
			last = { request, pick, ref: ref as (node: HTMLElement | null) => void };
			return ref;
		},
	};
}

export function useFocusRequest<T extends HTMLElement>(
	request: FocusRequest,
	pick?: FocusPick<T>,
): (node: T | null) => void {
	const [requests] = useState(createFocusRequests);
	return requests.ref(request, pick);
}
