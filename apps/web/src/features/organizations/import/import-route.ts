import "server-only";
import { requestDatabase } from "@/server/database";
import { pipelineActor } from "../pipeline-mount";
import { pipelineImportLimits } from "@everyfield/contracts/organizations";
import { readBoundedBody } from "@everyfield/domain/operations";
import { pipelineImportWriter, previewPipelineImport } from "@everyfield/domain/organizations";
import { logFailure } from "@everyfield/domain/log";
import { mutatingRoute } from "../../../server/platform/boundary.ts";

const NO_STORE = { "Cache-Control": "private, no-store" };
const reply = (body: unknown) => Response.json(body, { headers: NO_STORE });
const tooLarge = () => reply({ status: "refused", refusal: { code: "file_refused", problem: "file_too_large" } });
const BODY_MAX = pipelineImportLimits.bytes + 256 * 1024;

async function handle(request: Request, step: "preview" | "save") {
	if (Number(request.headers.get("content-length") ?? 0) > BODY_MAX) return tooLarge();
	const who = await pipelineActor();
	if (who.kind !== "seat") return reply({ status: "refused", refusal: { code: "unavailable" } });
	const db = requestDatabase();
	if (!db) return reply({ status: "lost" });
	let input: Record<string, unknown>;
	try {
		const bytes = await readBoundedBody(request, BODY_MAX);
		if (!bytes) return tooLarge();
		const form = await new Response(bytes, {
			headers: { "Content-Type": request.headers.get("content-type") ?? "" },
		}).formData();
		const file = form.get("file");
		const json = form.get("request");
		if (!(file instanceof File) || typeof json !== "string")
			return reply({ status: "refused", refusal: { code: "invalid_input" } });
		input = { ...JSON.parse(json), fileName: file.name, file: new Uint8Array(await file.arrayBuffer()) };
	} catch {
		return reply({ status: "refused", refusal: { code: "invalid_input" } });
	}
	try {
		return reply(
			step === "preview"
				? await previewPipelineImport(db, who.authority, input)
				: await pipelineImportWriter.importPeople(db, who.authority, input),
		);
	} catch (error) {
		logFailure({ component: "pipeline", outcome: `import_${step}_failed` }, error);
		return reply({ status: "lost" });
	}
}

export const previewRoute = mutatingRoute((request: Request) => handle(request, "preview"));
export const saveRoute = mutatingRoute((request: Request) => handle(request, "save"));
