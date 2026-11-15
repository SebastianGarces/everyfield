import type { NodeRef } from "./observe";

const FIELD = 'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)';

export function firstField(scope: ParentNode): HTMLElement | null {
	const invalid = scope.querySelector<HTMLElement>('[aria-invalid="true"]');
	if (invalid) return invalid;
	const first = scope.querySelector<HTMLElement>(FIELD);
	if (!(first instanceof HTMLInputElement) || first.type !== "radio" || !first.name) return first;
	return scope.querySelector<HTMLElement>(`input[type="radio"][name="${CSS.escape(first.name)}"]:checked`) ?? first;
}

export function focusOnMount(node: HTMLElement | null): void {
	node?.focus();
}

export function focusFirstField(node: HTMLElement | null): void {
	if (node) firstField(node)?.focus();
}

export type FocusHandoff = {
	from: NodeRef<HTMLElement>;
	to: (node: HTMLElement | null) => void;
};

export function createFocusHandoff(): FocusHandoff {
	let target: HTMLElement | null = null;
	let placed: HTMLElement | null | undefined;
	return {
		from: (node) => {
			if (!node) return;
			return () => {
				if (!node.contains(node.ownerDocument.activeElement)) return;
				placed = target?.isConnected && !node.contains(target) ? target : null;
				placed?.focus({ preventScroll: true });
			};
		},
		to: (node) => {
			target = node;
			if (!node || placed === undefined) return;
			const active = node.ownerDocument.activeElement;
			if (node !== placed && (active === placed || active === node.ownerDocument.body || active === null))
				node.focus({ preventScroll: true });
			placed = undefined;
		},
	};
}
