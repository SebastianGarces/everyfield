"use server";

import { programCall } from "@/server/organizations/programs";
import {
	programWriter,
	readEnrollment,
	readProgram,
	readVersionReview,
	readVersionReviews,
	searchReadings,
} from "@everyfield/domain/organizations";

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
export async function applyVersions(input: unknown) {
	return programCall((db, authority) => programWriter.applyVersions(db, authority, input));
}
export async function reviewVersions(programId: string, enrollmentIds: string[]) {
	return programCall((db, authority) => readVersionReviews(db, authority, { programId, enrollmentIds }));
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
