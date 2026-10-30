import { captureAllowed } from "../../../../features/communication/capture";
import { readOutbox } from "../../../../features/communication/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const html = (body: string) =>
	new Response(body, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:",
			"Cache-Control": "no-store",
		},
	});

/** Dev outbox: `/api/dev/outbox` lists recorded sends, `?id=` shows one with its exact rendered HTML. 404 elsewhere. */
export async function GET(request: Request) {
	if (!captureAllowed(process.env)) return new Response(null, { status: 404 });
	const entries = await readOutbox();
	const id = new URL(request.url).searchParams.get("id");
	if (id !== null) {
		const entry = entries.find((item) => item.id === id);
		return entry ? html(entry.html) : new Response(null, { status: 404 });
	}
	const rows = entries
		.map(
			(e) =>
				`<tr><td>${escape(e.at)}</td><td>${escape(e.to)}</td><td><a href="?id=${escape(e.id)}">${escape(e.subject)}</a></td></tr>`,
		)
		.join("");
	return html(
		`<!doctype html><title>Dev outbox</title><body style="font-family:system-ui;margin:2rem"><h1>Dev outbox</h1><p>${entries.length} recorded. Nothing was delivered.</p><table cellpadding="6"><tr><th align="left">Recorded</th><th align="left">To</th><th align="left">Subject</th></tr>${rows}</table>`,
	);
}
