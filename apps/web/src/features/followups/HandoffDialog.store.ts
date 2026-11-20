import { HANDOFF_LIMIT } from "@everyfield/contracts/followups";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Outcome } from "@everyfield/contracts/common";
import { keepSelection, type HandoffPlan, type HandoffResult } from "./model.ts";

export type HandoffPort = { loadPlan: (from: string) => Promise<Outcome<HandoffPlan>> };

export type HandoffState = {
	open: boolean;
	from: string;
	plan: Outcome<HandoffPlan> | null;
	selected: Set<string>;
	to: string;
	toError: string | null;
	result: HandoffResult | null;
	actions: {
		show: (open: boolean) => void;
		choose: (from: string) => void;
		preview: (account: string, keep: boolean) => Promise<void>;
		select: (selected: Set<string>) => void;
		give: (to: string) => void;
		refuse: (toError: string | null) => void;
		settle: (result: HandoffResult | null) => void;
		reset: () => void;
	};
};

export type HandoffStore = StoreApi<HandoffState>;

export const planOf = (s: Pick<HandoffState, "plan">) => (s.plan?.status === "ok" ? s.plan.value : null);

export function createHandoffStore(port: HandoffPort): HandoffStore {
	let asked = "";
	return createStore<HandoffState>()((set, get) => ({
		open: false,
		from: "",
		plan: null,
		selected: new Set(),
		to: "",
		toError: null,
		result: null,
		actions: {
			show: (open) => set({ open }),
			choose: (from) => set({ from }),
			preview: async (account, keep) => {
				const key = `${account}:${crypto.randomUUID()}`;
				asked = key;
				if (!keep) set({ plan: null });
				const r = await port.loadPlan(account);
				if (asked !== key) return;
				if (r.status !== "ok") return set({ plan: r });
				const open = r.value.duties;
				const { selected, to } = get();
				set({
					plan: r,
					selected: keep ? keepSelection(selected, open) : new Set(open.slice(0, HANDOFF_LIMIT).map((d) => d.taskId)),
					to: keep && r.value.recipients.some((x) => x.accountId === to) ? to : "",
				});
			},
			select: (selected) => set({ selected }),
			give: (to) => set({ to }),
			refuse: (toError) => set({ toError }),
			settle: (result) => set({ result }),
			reset: () => {
				asked = "";
				set({ from: "", plan: null, selected: new Set(), to: "", toError: null, result: null });
			},
		},
	}));
}
