import prettier from "eslint-config-prettier/flat";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import oxlint from "eslint-plugin-oxlint";

const recordDialogFocus = {
	name: "RecordDialog sets the opening focus in its onOpenAutoFocus handler; a field that always takes autoFocus inside it breaks the refusal focus, the Tab trap and the Escape return, while autoFocus={state} for a field the person switches to stays allowed",
	files: ["src/**/*.tsx"],
	rules: {
		"no-restricted-syntax": [
			"error",
			{
				selector:
					'JSXElement[openingElement.name.name="RecordDialog"] JSXAttribute[name.name="autoFocus"]:matches(:not([value]), [value.expression.value=true])',
				message:
					"RecordDialog sets the opening focus itself. Remove autoFocus from its content; use autoFocus={state} only for a field the person switches to after the dialog opens.",
			},
		],
	},
};

const vendoredTiptap = {
	name: "Vendored Tiptap UI components keep upstream's effects, render-time ref reads and local ref writes so later upstream updates stay comparable; editor/tiptap/README.md lists the Everyfield changes per file",
	files: ["src/features/documents/church/editor/tiptap/**"],
	rules: {
		"react-hooks/set-state-in-effect": "off",
		"react-hooks/refs": "off",
		"react-hooks/immutability": "off",
	},
};

const nativeElements = {
	name: "NativeImage shows data URLs, local object URLs and private per-request asset routes, which next/image would fetch, optimize and cache; FullPageLink loads the next page in full so it reads state the current action just created",
	files: ["src/components/native.tsx"],
	rules: { "@next/next/no-img-element": "off", "@next/next/no-html-link-for-pages": "off" },
};

const oxlintEnforces = [
	...oxlint.buildFromOxlintConfigFile(`${import.meta.dirname}/.oxlintrc.json`),
	{
		name: "oxlint/compiler-options: these check only the compiler options a rule is given; Oxlint runs the compiler with fixed, valid options, and left on either runs the whole compiler in ESLint again",
		rules: { "react-hooks/config": "off", "react-hooks/gating": "off" },
	},
	{
		name: "oxlint/disable-comments: a disable comment names a rule of one tool and the other reports it unused",
		linterOptions: { reportUnusedDisableDirectives: "off" },
	},
];

const config = [
	...nextVitals,
	...nextTs,
	prettier,
	recordDialogFocus,
	vendoredTiptap,
	nativeElements,
	...oxlintEnforces,
	{ ignores: [".next/**", "next-env.d.ts"] },
];

export default config;
