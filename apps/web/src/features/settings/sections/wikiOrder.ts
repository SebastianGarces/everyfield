import type { OrderRead, OrderRow, OrderSave } from "../port";
import type { Refusal } from "../save";

export type WikiOrderView = Extract<OrderRead, { status: "ok" }>;
export type WikiOrder = { churches: string[]; networks: string[] };
export type OrderKind = keyof WikiOrder;

export const orderOf = (view: WikiOrderView): WikiOrder => ({
	churches: view.churches.map((row) => row.id),
	networks: view.networks.map((row) => row.id),
});

export function rowsInOrder(rows: OrderRow[], ids: string[]): OrderRow[] {
	return ids.flatMap((id) => rows.filter((row) => row.id === id));
}

export function moved(ids: string[], index: number, step: -1 | 1): string[] {
	const to = index + step;
	const moving = ids[index];
	const other = ids[to];
	if (moving === undefined || other === undefined) return ids;
	const next = ids.slice();
	next[index] = other;
	next[to] = moving;
	return next;
}

export const orderNeeded = (view: WikiOrderView) => view.revision === "0" && view.churches.length > 1;

export const savedView = (view: WikiOrderView, order: WikiOrder, revision: string): WikiOrderView => ({
	...view,
	revision,
	churches: rowsInOrder(view.churches, order.churches),
	networks: rowsInOrder(view.networks, order.networks),
});

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
