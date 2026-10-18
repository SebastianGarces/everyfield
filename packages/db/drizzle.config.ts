import { defineConfig } from "drizzle-kit";
export default defineConfig({
	dialect: "postgresql",
	schema: ["./src/schema/tables.ts", "./src/schema/roles.ts"],
	out: "./migrations",
	breakpoints: true,
});
