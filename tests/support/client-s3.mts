import { createRequire } from "node:module";
import type * as ClientS3 from "@aws-sdk/client-s3";

const fromDatabasePackage = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const clientS3: typeof ClientS3 = fromDatabasePackage("@aws-sdk/client-s3");
export const { S3Client } = clientS3;
