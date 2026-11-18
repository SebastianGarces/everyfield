import { captureAllowed } from "../../server/mail/capture.ts";
import { readOutbox } from "./outbox.ts";

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const html = (body: string) =>
	new Response(body, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:",
			"Cache-Control": "no-store",
		},
	});

export async function outboxRoute(request: Request) {
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
				`<tr><td>${escape(e.at)}</td><td>${escape(e.to)}</td><td><a href="?id=${escape(e.id)}">${escape(e.subject)}</a></td><td><code>${Object.entries(
					e.headers ?? {},
				)
					.map(([name, value]) => escape(`${name}: ${value}`))
					.join("<br>")}</code></td></tr>`,
		)
		.join("");
	return html(
		`<!doctype html><title>Dev outbox</title><body style="font-family:system-ui;margin:2rem"><h1>Dev outbox</h1><p>${entries.length} recorded. Nothing was delivered.</p><table cellpadding="6"><tr><th align="left">Recorded</th><th align="left">To</th><th align="left">Subject</th><th align="left">Headers</th></tr>${rows}</table>`,
	);
}
