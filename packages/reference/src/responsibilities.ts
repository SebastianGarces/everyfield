// Stable reference choices only. The plant owner explicitly maps actual roles; names grant nothing.
export const methodologyResponsibilities = [
	{ key: "worship", templateRole: { team: "worship", role: "worship_leader" } },
	{ key: "children", templateRole: { team: "childrens_ministry", role: "childrens_ministry_director" } },
	{ key: "assimilation", templateRole: { team: "assimilation", role: "assimilation_director" } },
	{ key: "small_groups", templateRole: { team: "small_groups", role: "small_groups_director" } },
	{ key: "administration_finance", templateRole: null },
	{ key: "facilities", templateRole: { team: "facilities", role: "facilities_director" } },
	{ key: "promotion", templateRole: { team: "promotion", role: "promotion_director" } },
	{ key: "technology", templateRole: { team: "technology", role: "technology_director" } },
] as const;
export const separatePrayerResponsibility = {
	key: "prayer",
	templateRole: { team: "prayer", role: "prayer_director" },
} as const;
