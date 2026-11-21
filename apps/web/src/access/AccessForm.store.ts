import { createStore } from "zustand/vanilla";

export type AccessFormState = {
	sending: boolean;
	actions: { send: (request: () => Promise<void>) => Promise<void> };
};

export function createAccessFormStore() {
	return createStore<AccessFormState>()((set, get) => ({
		sending: false,
		actions: {
			send: async (request) => {
				if (get().sending) return;
				set({ sending: true });
				try {
					await request();
				} finally {
					set({ sending: false });
				}
			},
		},
	}));
}
