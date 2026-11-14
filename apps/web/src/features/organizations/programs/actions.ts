"use server";

import { programCall } from "@/server/organizations/programs";
import {
	programWriter,
	readEnrollment,
	readProgram,
	readVersionReview,
	searchReadings,
} from "@everyfield/domain/organizations";

// Server actions behind the Programs tab, a program and an enrollment. Each one rebuilds the request actor; the domain
// parses the input and rechecks the seat and the duty. A screen reads again only the record that changed.

export async function createProgram(input: unknown) {
	return programCall((db, authority) => programWriter.createProgram(db, authority, input));
}
export async function savePlan(input: unknown) {
	return programCall((db, authority) => programWriter.savePlan(db, authority, input));
}
export async function publishVersion(input: unknown) {
	return programCall((db, authority) => programWriter.publishVersion(db, authority, input));
}
export async function enroll(input: unknown) {
	return programCall((db, authority) => programWriter.enroll(db, authority, input));
}
export async function recordMilestone(input: unknown) {
	return programCall((db, authority) => programWriter.recordMilestone(db, authority, input));
}
export async function confirmMilestone(input: unknown) {
	return programCall((db, authority) => programWriter.confirmMilestone(db, authority, input));
}
export async function addFeedback(input: unknown) {
	return programCall((db, authority) => programWriter.addFeedback(db, authority, input));
}
export async function applyVersion(input: unknown) {
	return programCall((db, authority) => programWriter.applyVersion(db, authority, input));
}
export async function reviewVersion(enrollmentId: string) {
	return programCall((db, authority) => readVersionReview(db, authority, { enrollmentId }));
}
export async function findReadings(q: string) {
	return programCall((db, authority) => searchReadings(db, authority, { q }));
}
export async function rereadProgram(programId: string) {
	return programCall((db, authority) => readProgram(db, authority, { programId }));
}
export async function rereadEnrollment(enrollmentId: string) {
	return programCall((db, authority) => readEnrollment(db, authority, { enrollmentId }));
}
