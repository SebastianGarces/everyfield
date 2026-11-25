import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

type Font = {
	fontFamily: string;
	weights: string[];
	styles: string[];
	selectedVariableAxes?: string[];
	display: string;
};

function googleFontsMock(app: string, fontOrigin: string): Record<string, string> {
	const require = createRequire(join(app, "package.json"));
	const google = (file: string) => require(`next/dist/compiled/@next/font/dist/google/${file}`);
	const { validateGoogleFontFunctionCall } = google("validate-google-font-function-call.js");
	const { getFontAxes } = google("get-font-axes.js");
	const { getGoogleFontsUrl } = google("get-google-fonts-url.js");
	const mock: Record<string, string> = {};
	for (const file of globSync("src/**/*.{ts,tsx}", { cwd: app })) {
		const text = readFileSync(join(app, file), "utf8");
		const imported = text.match(/import\s*\{([^}]*)\}\s*from\s*["']next\/font\/google["']/)?.[1] ?? "";
		for (const name of imported.match(/\w+/g) ?? [])
			for (const [, options] of text.matchAll(new RegExp(`\\b${name}\\((\\{[^)]*\\})\\)`, "g"))) {
				const font: Font = validateGoogleFontFunctionCall(name, vm.runInNewContext(`(${options})`));
				const axes = getFontAxes(font.fontFamily, font.weights, font.styles, font.selectedVariableAxes);
				mock[getGoogleFontsUrl(font.fontFamily, axes, font.display)] =
					`/* latin */\n@font-face {\n  font-family: '${font.fontFamily}';\n  font-style: normal;\n  font-weight: 400;\n` +
					`  font-display: swap;\n  src: url(${fontOrigin}/font.woff2) format('woff2');\n}\n`;
			}
	}
	if (!Object.keys(mock).length) throw Error("found no next/font/google call in apps/web/src");
	return mock;
}

export async function serveGoogleFonts(app: string) {
	let requests = 0;
	const server = createServer((_, response) => {
		requests++;
		response.writeHead(200, { "content-type": "font/woff2" }).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const dir = mkdtempSync(join(tmpdir(), "google-fonts-"));
	const close = () => {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	};
	try {
		const mock = googleFontsMock(app, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
		const mockFile = join(dir, "google-fonts.cjs");
		writeFileSync(mockFile, `module.exports = ${JSON.stringify(mock)};\n`);
		return { env: { NEXT_FONT_GOOGLE_MOCKED_RESPONSES: mockFile }, requests: () => requests, close };
	} catch (error) {
		close();
		throw error;
	}
}
