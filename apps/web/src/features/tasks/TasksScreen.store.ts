import { createStore, type StoreApi } from "zustand/vanilla";
import { SaveLane, type LaneOptions } from "../../components/save/model.ts";
import type { Report } from "./bulk.tsx";
import { BadgeReads, problemText, type TaskCounts, type TaskItem } from "./model.ts";
import type { EditForm } from "./TaskDialog.tsx";
import type { DetailState, PanelEdit } from "./TaskSheet.tsx";
import type { TasksAnswer } from "./TasksScreen.tsx";

export type TaskForm = EditForm | (PanelEdit & { problem?: string });
export const NEW = "new";
export const BULK = "bulk";

export class Lanes {
	#lanes = new Map<string, SaveLane<TaskForm>>();
	#listeners = new Set<() => void>();
	#version = 0;
	readonly #options: (id: string) => LaneOptions;
	constructor(options: (id: string) => LaneOptions) {
		this.#options = options;
	}
	of = (id: string): SaveLane<TaskForm> => {
		let lane = this.#lanes.get(id);
		if (!lane) {
			lane = new SaveLane<TaskForm>(this.#options(id));
			lane.subscribe(() => {
				this.#version++;
				for (const l of this.#listeners) l();
			});
			this.#lanes.set(id, lane);
		}
		return lane;
	};
	notices = (): [string, SaveLane<TaskForm>][] => [...this.#lanes].filter(([, l]) => l.get().notice !== null);
	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => void this.#listeners.delete(listener);
	};
	version = () => this.#version;
}

export type TasksPageData = {
	items: TaskItem[];
	counts: TaskCounts;
	total: number;
	selected: ReadonlySet<string>;
	report: Report | null;
	badgesStale: boolean;
	readingBadges: boolean;
};

export type TasksPageState = TasksPageData & {
	badgeReads: BadgeReads;
	actions: { change: (change: (page: TasksPageData) => Partial<TasksPageData>) => void };
};

export type TasksPageStore = StoreApi<TasksPageState>;

export function createTasksPageStore(answer: TasksAnswer): TasksPageStore {
	return createStore<TasksPageState>()((set, get) => ({
		items: answer.page.items,
		counts: answer.counts,
		total: answer.page.total,
		selected: new Set(),
		report: null,
		badgesStale: false,
		readingBadges: false,
		badgeReads: new BadgeReads(),
		actions: { change: (change) => set(change(get())) },
	}));
}

export type TasksState = {
	details: Record<string, DetailState>;
	openId: string | null;
	dialogFor: string | null;
	deleting: TaskItem | null;
	lanes: Lanes;
	actions: {
		details: (change: (details: Record<string, DetailState>) => Record<string, DetailState>) => void;
		show: (id: string | null) => void;
		dialog: (id: string | null) => void;
		confirmDelete: (task: TaskItem | null) => void;
		startLoading: (id: string) => boolean;
		stopLoading: (id: string) => void;
		openForm: (id: string, form: TaskForm) => void;
		closeForm: (id: string) => void;
		leaveForm: (keep?: string) => void;
		holdBulk: (ids: readonly string[]) => void;
		startBulk: (chosen: readonly string[], start: () => void) => void;
	};
};

export type TasksStore = StoreApi<TasksState>;

export function createTasksStore(init: { opened: TasksAnswer["opened"] }): TasksStore {
	let formLane: string | null = null;
	let bulkHeld: readonly string[] = [];
	let bulkChosen: readonly string[] = [];
	const loading = new Set<string>();
	return createStore<TasksState>()((set, get) => {
		const lanes: Lanes = new Lanes((id): LaneOptions => ({
			explain: (code) => problemText(code as never),
			report: (line) => console.error(line),
			busy:
				id === BULK
					? (): boolean => bulkChosen.some((t) => lanes.of(t).wait() !== null)
					: (): boolean => {
							const bulk = lanes.of(BULK).get();
							return (bulk.saving || bulk.notice?.tone === "unknown") && bulkHeld.includes(id);
						},
		}));
		const leaveForm = (keep?: string) => {
			if (!formLane || formLane === keep) return;
			lanes.of(formLane).close();
			formLane = null;
		};
		return {
			details: init.opened ? { [init.opened.task.id]: { status: "ok", ...init.opened } } : {},
			openId: init.opened?.task.id ?? null,
			dialogFor: null,
			deleting: null,
			lanes,
			actions: {
				details: (change) => set({ details: change(get().details) }),
				show: (id) => set({ openId: id }),
				dialog: (id) => set({ dialogFor: id }),
				confirmDelete: (task) => set({ deleting: task }),
				startLoading: (id) => {
					if (loading.has(id)) return false;
					loading.add(id);
					return true;
				},
				stopLoading: (id) => void loading.delete(id),
				openForm: (id, form) => {
					leaveForm(id);
					formLane = id;
					lanes.of(id).open(form);
					if (form.kind === "edit") set({ dialogFor: id });
				},
				closeForm: (id) => {
					lanes.of(id).close();
					if (formLane === id) formLane = null;
				},
				leaveForm,
				holdBulk: (ids) => {
					bulkHeld = ids;
				},
				startBulk: (chosen, start) => {
					bulkChosen = chosen;
					try {
						start();
					} finally {
						bulkChosen = [];
					}
				},
			},
		};
	});
}
