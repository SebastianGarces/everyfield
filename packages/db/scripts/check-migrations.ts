import { checkMigrationArtifacts } from "../src/schema/artifacts.ts";
await checkMigrationArtifacts();
console.log("Migration registry, frozen bytes and generated SQL qualification agree.");
