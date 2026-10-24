/** Stable Playbook checklist. A new reference_version offers these keys again only when the team has no row for that key. */
export const RESPONSIBILITY_ITEM_KIND = "playbook" as const;
export const RESPONSIBILITY_CATALOG_KEY = "responsibilities" as const;
export const RESPONSIBILITY_LINES = [
	{ key: "invite", text: "Invite new people each week", sortOrder: 1 },
	{ key: "follow-up", text: "Follow up with every guest", sortOrder: 2 },
	{ key: "train", text: "Train the team before launch", sortOrder: 3 },
] as const;
export const RESPONSIBILITY_PAGE = 24;
