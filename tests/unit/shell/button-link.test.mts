import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ButtonLink, type ButtonSize, type ButtonVariant } from "../../../apps/web/src/components/ButtonLink.tsx";

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");

type Props = Parameters<typeof ButtonLink>[0];
const needsHref: Record<never, never> extends Pick<Props, "href"> ? false : true = true;
const hrefIsText: undefined extends Props["href"] ? false : true = true;
const takesNoHandler: Extract<keyof Props, `on${string}`> extends never ? true : false = true;

const VARIANTS: Record<ButtonVariant, true> = {
	primary: true,
	secondary: true,
	inverse: true,
	photo: true,
	"photo-secondary": true,
};
const SIZES: Record<ButtonSize, true> = { md: true, nav: true, pill: true, footer: true };

test("INV-button-link: a ButtonLink is an <a> with its href and never a <button>, in every variant and size", () => {
	assert.ok(needsHref && hrefIsText && takesNoHandler);
	for (const variant of [undefined, ...Object.keys(VARIANTS)])
		for (const size of [undefined, ...Object.keys(SIZES)])
			for (const current of [false, true]) {
				const html: string = renderToStaticMarkup(
					createElement(ButtonLink, { href: "/access", variant, size, current, children: "Ask for access" }),
				);
				assert.match(html, /^<a [^>]*href="\/access"[^>]*>Ask for access<\/a>$/, `${variant} ${size}`);
			}
});
