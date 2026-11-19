export * from "drizzle-orm";
export { alias } from "drizzle-orm/pg-core";
export type SqlLiteral<A extends string> = Record<never, never> extends Record<A, true> ? never : A;
