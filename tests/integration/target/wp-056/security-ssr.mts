import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const web = createRequire(new URL("../../../../apps/web/package.json", import.meta.url));
const COMPILED: Record<string, string> = {
	"react-server-dom-webpack/client": "next/dist/compiled/react-server-dom-webpack/client.node.js",
};
registerHooks({
	resolve: (specifier, context, next) => {
		if (specifier === "server-only" || specifier.endsWith(".css"))
			return { url: "data:text/javascript,", shortCircuit: true };
		const compiled = COMPILED[specifier];
		if (compiled) return { url: pathToFileURL(web.resolve(compiled)).href, shortCircuit: true };
		return next(specifier, context);
	},
});
const react = web("react") as typeof import("react");
const { createElement } = react;
(globalThis as { React?: unknown }).React = react;
const { renderToString } = web("react-dom/server") as typeof import("react-dom/server");
const { AppRouterContext } = web("next/dist/shared/lib/app-router-context.shared-runtime");
const { PathnameContext, SearchParamsContext } = web("next/dist/shared/lib/hooks-client-context.shared-runtime");

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { module, name, props, pathname } = JSON.parse(input) as {
	module: string;
	name: string;
	props: Record<string, unknown>;
	pathname: string;
};
const loaded = (await import(pathToFileURL(module).href)) as Record<string, Parameters<typeof createElement>[0]>;
const noop = () => {};
const router = { push: noop, replace: noop, refresh: noop, prefetch: noop, back: noop, forward: noop };
const view = createElement(loaded[name]!, props);
const html = renderToString(
	createElement(
		AppRouterContext.Provider,
		{ value: router },
		createElement(
			PathnameContext.Provider,
			{ value: pathname },
			createElement(SearchParamsContext.Provider, { value: new URLSearchParams() }, view),
		),
	),
);
process.stdout.write(html);
