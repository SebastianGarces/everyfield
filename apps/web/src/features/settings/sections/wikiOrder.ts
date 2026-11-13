import type { OrderRead, OrderRow, OrderSave } from "../port";
import type { Refusal } from "../save";

// Pure rules for the Wiki sources section: the draft is the two id lists in reading order, and each save reply is
// a sentence the person can act on.

export type WikiOrderView = Extract<OrderRead, { status: "ok" }>;
export type WikiOrder = { churches: string[]; networks: string[] };
export type OrderKind = keyof WikiOrder;

export const orderOf = (view: WikiOrderView): WikiOrder => ({
	churches: view.churches.map((row) => row.id),
	networks: view.networks.map((row) => row.id),
});

/** The rows in the draft's order. An id the draft names that the server no longer lists is left out. */
export function rowsInOrder(rows: OrderRow[], ids: string[]): OrderRow[] {
	return ids.flatMap((id) => rows.filter((row) => row.id === id));
}

/** The list with the entry at `index` moved one place up (-1) or down (1); unchanged at either end. */
export function moved(ids: string[], index: number, step: -1 | 1): string[] {
	const to = index + step;
	if (to < 0 || to >= ids.length) return ids;
	const next = ids.slice();
	[next[index], next[to]] = [next[to]!, next[index]!];
	return next;
}

/** Revision "0" means no order is stored. With two or more churches, competing church versions wait for one. */
export const orderNeeded = (view: WikiOrderView) => view.revision === "0" && view.churches.length > 1;

/** The view after a save of `order` returned `revision`. */
export const savedView = (view: WikiOrderView, order: WikiOrder, revision: string): WikiOrderView => ({
	...view,
	revision,
	churches: rowsInOrder(view.churches, order.churches),
	networks: rowsInOrder(view.networks, order.networks),
});

/** A refused or failed save, in words. Every one keeps the unsaved order on screen. */
export function saveRefusal(reply: Exclude<OrderSave, { status: "ok" }>): Refusal {
	switch (reply.status) {
		case "conflict":
			return {
				message: "The order changed elsewhere after you opened this, so yours was not saved.",
				reference: "",
				code: "conflict",
			};
		case "denied":
			return {
				message: "The order was not saved. Only an Owner or Admin of your church can set it.",
				reference: "",
				code: "access_denied",
			};
		case "required":
		case "invalid":
			return {
				message: "The order was not saved because the list of sources changed. Load the current order and try again.",
				reference: "",
				code: "conflict",
			};
		case "lost":
			return {
				message: "The order did not save. Your order is still here, so you can try again.",
				reference: "",
				code: "temporary",
			};
	}
}
