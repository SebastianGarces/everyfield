import type { listVenuesRequest } from "@everyfield/contracts/meetings";
import type { z } from "zod";
import { getReads } from "../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/meetings/read");

export const searchPeople = (query: string) => get("people", query);
export const listMinistries = () => get("ministries");
export const previewRoster = (meetingId: string) => get("roster", { meetingId });
export const listVenues = (request: z.input<typeof listVenuesRequest>) => get("venues", request);
export const getVenue = (venueId: string) => get("venue", { venueId });
