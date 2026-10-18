import { verifySnapshotBaseline } from "../src/schema/drift.ts";
import { checkMigrationArtifacts } from "../src/schema/artifacts.ts";
await checkMigrationArtifacts();
await verifySnapshotBaseline();
console.log("Migration registry, frozen bytes, snapshot and generated SQL qualification agree.");
