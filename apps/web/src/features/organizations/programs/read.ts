import {
	readEnrollment,
	readProgram,
	readVersionReview,
	readVersionReviews,
	searchReadings,
} from "@everyfield/domain/organizations";
import "server-only";
import { organizationSeat } from "@/server/request-context";
import { z } from "zod";
import { defineReads } from "../../../server/platform/reads.ts";
import { programCall } from "./mount";

export const GET = defineReads(
	async () => (await organizationSeat())?.authority ?? null,
	"unavailable",
	(get) => ({
		review: get(z.strictObject({ enrollmentId: z.string() }), (authority, v) =>
			programCall((db, a) => readVersionReview(db, a, v), authority),
		),
		reviews: get(z.strictObject({ programId: z.string(), enrollmentIds: z.array(z.string()) }), (authority, v) =>
			programCall((db, a) => readVersionReviews(db, a, v), authority),
		),
		readings: get(z.strictObject({ q: z.string() }), (authority, v) =>
			programCall((db, a) => searchReadings(db, a, v), authority),
		),
		program: get(z.strictObject({ programId: z.string() }), (authority, v) =>
			programCall((db, a) => readProgram(db, a, v), authority),
		),
		enrollment: get(z.strictObject({ enrollmentId: z.string() }), (authority, v) =>
			programCall((db, a) => readEnrollment(db, a, v), authority),
		),
	}),
);
