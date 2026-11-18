import type { ToastInput } from "@everyfield/ui/controls";
import { createStore } from "zustand/vanilla";
import { deleteMeeting, reloadMeeting } from "./actions.ts";
import { sendTwice } from "../../components/save/model.ts";
import { problemText } from "./model.ts";

export type DeletionsState = {
	hidden: ReadonlySet<string>;
	actions: {
		hide: (id: string) => void;
		show: (id: string) => void;
	};
};

export function createDeletionsStore() {
	return createStore<DeletionsState>()((set, get) => ({
		hidden: new Set(),
		actions: {
			hide: (id) => set({ hidden: new Set(get().hidden).add(id) }),
			show: (id) => {
				const hidden = new Set(get().hidden);
				hidden.delete(id);
				set({ hidden });
			},
		},
	}));
}

export const deletions = createDeletionsStore();

const lost = () => ({ status: "lost" }) as const;

export function deleteFromList(
	m: { id: string; title: string; revision: string },
	reason: string,
	toast: (t: ToastInput) => void,
) {
	const key = crypto.randomUUID();
	const { hide, show } = deletions.getState().actions;
	const deleted = () => toast({ message: `${m.title} was deleted.`, tone: "success" });
	const notDeleted = (why: string) => {
		show(m.id);
		toast({ message: `${m.title} was not deleted. ${why}`, tone: "error" });
	};
	const attempt = async () => {
		const r = await sendTwice(() => deleteMeeting(key, m.revision, m.id, reason));
		if (r.status === "ok") return deleted();
		if (r.status === "refused") return notDeleted(problemText(r.code));
		const seen = await reloadMeeting(m.id).catch(lost);
		const state = seen.status === "ok" ? seen.value.status : "unknown";
		if (state === "missing") return deleted();
		if (state === "found") return notDeleted("We did not hear back from the server. Try again.");
		toast({
			message: `We could not confirm that ${m.title} was deleted. It stays hidden until we know.`,
			tone: "error",
			action: { label: "Try again", altText: "Reload the meetings list to check", onSelect: () => void attempt() },
		});
	};
	hide(m.id);
	void attempt();
}
