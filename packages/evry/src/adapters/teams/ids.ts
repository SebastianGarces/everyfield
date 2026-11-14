import { z } from "zod";

/**
 * An id from an earlier result, as the teams tools take it. Its pattern is short on purpose: every tool schema reaches
 * the model on every call, and z.uuid()'s pattern is about 170 characters.
 */
export const recordId = z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
