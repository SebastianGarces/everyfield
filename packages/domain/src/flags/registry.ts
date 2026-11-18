type FlagKind = "release" | "kill" | "ops";
type Day = `${number}-${number}-${number}`;

export type FlagDeclaration = {
	readonly owner: string;
	readonly task: `T-${number}`;
	readonly kind: FlagKind;
	readonly default: boolean;
	readonly created: Day;
	readonly expires: Day;
};

export type Registry = Readonly<Record<string, FlagDeclaration>>;

export const registry = {
	"overview-role-subtitle": {
		owner: "Sebastian",
		task: "T-470",
		kind: "release",
		default: false,
		created: "2026-11-18",
		expires: "2027-02-18",
	},
} as const satisfies Registry;

export type FlagName = keyof typeof registry;
