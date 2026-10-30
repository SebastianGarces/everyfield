// Prints "<template id> <sha256>" for every template. The determinism test runs it in two separate Node processes.
import { createHash } from "node:crypto";
import { renderPreview } from "../../../../packages/domain/src/documents/render.ts";
import { library } from "../../../../packages/domain/src/documents/catalog.ts";
import { resolveMerge } from "../../../../packages/domain/src/documents/merge.ts";

const { templates } = await library();
for (const template of templates) {
	const resolved = resolveMerge(
		template,
		{ churchName: "Harborlight Church", pastorName: "Pastor Daniel Reyes", launchDate: "Sunday, April 11, 2027" },
		{},
	);
	if (!resolved.ok) throw new Error(template.id);
	const bytes = await renderPreview(template, template.formats[0]!, resolved);
	if (!bytes) throw new Error(template.id);
	console.log(template.id, createHash("sha256").update(bytes).digest("hex"));
}
