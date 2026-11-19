import "server-only";
import { requestDatabase } from "@/server/database";
import { pipelineActor } from "../pipeline-mount";
import { pipelineImportLimits } from "@everyfield/contracts/organizations";
import { readBoundedBody } from "@everyfield/domain/operations";
import { pipelineImportWriter, previewPipelineImport } from "@everyfield/domain/organizations";
import { mutatingRoute } from "../../../server/platform/boundary.ts";
import { parseJson } from "../../../server/platform/json.ts";
import { transient } from "../../../server/platform/transient.ts";

const NO_STORE = { "Cache-Control": "private, no-store" };
const reply = (body: unknown) => Response.json(body, { headers: NO_STORE });
const tooLarge = () => reply({ status: "refused", refusal: { code: "file_refused", problem: "file_too_large" } });
const BODY_MAX = pipelineImportLimits.bytes + 256 * 1024;

async function handle(request: Request, step: "preview" | "save") {
	if (Number(request.headers.get("content-length") ?? 0) > BODY_MAX) return tooLarge();
	const who = await pipelineActor();
	if (who.kind !== "seat") return reply({ status: "refused", refusal: { code: "unavailable" } });
	const db = requestDatabase();
	const invalid = () => reply({ status: "refused", refusal: { code: "invalid_input" } });
	const bytes = await readBoundedBody(request, BODY_MAX);
	if (!bytes) return tooLarge();
	const form = await new Response(bytes, {
		headers: { "Content-Type": request.headers.get("content-type") ?? "" },
	})
		.formData()
		.catch((error: unknown) => {
			if (error instanceof TypeError) return null;
			throw error;
		});
	const file = form?.get("file");
	const fields = form?.get("request");
	const parsed = typeof fields === "string" ? parseJson(fields) : undefined;
	if (!(file instanceof File) || !parsed || typeof parsed !== "object") return invalid();
	const input = { ...parsed, fileName: file.name, file: new Uint8Array(await file.arrayBuffer()) };
	return transient(
		{ component: "pipeline", outcome: `import_${step}_failed` },
		async () =>
			reply(
				step === "preview"
					? await previewPipelineImport(db, who.authority, input)
					: await pipelineImportWriter.importPeople(db, who.authority, input),
			),
		reply({ status: "lost" }),
	);
}

export const previewRoute = mutatingRoute((request: Request) => handle(request, "preview"));
export const saveRoute = mutatingRoute((request: Request) => handle(request, "save"));
