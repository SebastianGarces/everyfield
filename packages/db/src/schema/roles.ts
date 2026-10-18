import { pgRole } from "drizzle-orm/pg-core";
// The frozen/custom migrations own role attributes and GRANTs. Kit must never recreate shared roles.
export const runtimeRole = pgRole("everyfield_runtime").existing();
export const authRole = pgRole("everyfield_auth").existing();
export const cleanupRole = pgRole("everyfield_cleanup").existing();
