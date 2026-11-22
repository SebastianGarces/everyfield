"use server";

import { programCall } from "./mount";
import { programWriter } from "@everyfield/domain/organizations";

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
export async function applyVersions(input: unknown) {
	return programCall((db, authority) => programWriter.applyVersions(db, authority, input));
}
