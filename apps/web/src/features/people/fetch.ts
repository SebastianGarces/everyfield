import { getReads } from "../../components/get-reads.ts";
import type { ColumnValue } from "./model.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/people/read");

export const loadPeopleView = async (search: string) => {
	const r = await get("view", { search });
	return "status" in r ? null : r;
};
export const reloadPerson = (personId: string) => get("person", { personId });
export const statusWarnings = (personId: string) => get("warnings", { personId });
export const loadActivities = (personId: string, page = 1) => get("activities", { personId, page });
export const loadColumn = (query: Record<string, unknown>, column: ColumnValue, page: number) =>
	get("column", { query, column, page });
export const loadAssessments = (personId: string, page: number) => get("assessments", { personId, page });
export const loadInterviews = (personId: string, page: number) => get("interviews", { personId, page });
export const loadCommitments = (personId: string, page: number) => get("commitments", { personId, page });
export const listChurchTags = () => get("tags", {});
export const readSkills = (personId: string) => get("skills", { personId });
export const readHousehold = (personId: string) => get("household", { personId });
export const readPhoto = (personId: string) => get("photo", { personId });
export const findHouseholds = (search: string) => get("households", { search });
export const findWitnesses = (search: string) => get("witnesses", { search });
export const loadPersonPage = (personId: string) => get("page", { personId });
export const loadRecords = (personId: string) => get("records", { personId });
export const reviewPair = (query: { person: string; with: string; keep: string | null }) => get("pair", query);
export const mergeDestination = (personId: string) => get("destination", { personId });
export const unmergePreview = (mergeId: string) => get("unmerge", { mergeId });
