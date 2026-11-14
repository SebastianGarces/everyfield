import "server-only";
import { requestDatabase } from "@/server/database";
import { pipelineActor } from "@/server/organizations/pipeline";
import { pipelineImportLimits } from "@everyfield/contracts/organizations";
import { pipelineImportWriter, previewPipelineImport } from "@everyfield/domain/organizations";

// POST /organization/pipeline/import/preview and /organization/pipeline/import/save (T-363) with multipart form data:
// `file`, the chosen file, and `request`, the JSON of everything else. A server action caps its body at the host's
// action limit, so the file goes to its own routes, as the Word import does. The server reads the bytes itself each
// time; the browser never sends parsed rows. Every reply is JSON: ok, refused with the refusal, or lost.

const NO_STORE = { "Cache-Control": "private, no-store" };
const reply = (body: unknown) => Response.json(body, { headers: NO_STORE });
const tooLarge = () => reply({ status: "refused", refusal: { code: "file_refused", problem: "file_too_large" } });
/** The file plus the form's envelope and the request JSON. */
const BODY_MAX = pipelineImportLimits.bytes + 256 * 1024;

/** The body's bytes, or null once it passes `max`: a body with no length header is counted as it arrives. */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
	if (!request.body) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = request.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

async function handle(request: Request, step: "preview" | "save") {
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin") return new Response(null, { status: 403, headers: NO_STORE });
	if (Number(request.headers.get("content-length") ?? 0) > BODY_MAX) return tooLarge();
	const who = await pipelineActor();
	if (who.kind !== "seat") return reply({ status: "refused", refusal: { code: "unavailable" } });
	const db = requestDatabase();
	if (!db) return reply({ status: "lost" });
	let input: Record<string, unknown>;
	try {
		const bytes = await readCapped(request, BODY_MAX);
		if (!bytes) return tooLarge();
		const form = await new Response(bytes as BodyInit, {
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
		console.error(JSON.stringify({ component: "pipeline", outcome: `import_${step}_failed`, error: String(error) }));
		return reply({ status: "lost" });
	}
}

export const previewRoute = (request: Request) => handle(request, "preview");
export const saveRoute = (request: Request) => handle(request, "save");
