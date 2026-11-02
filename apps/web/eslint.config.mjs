import prettier from "eslint-config-prettier/flat";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// RecordDialog alone sets the opening focus in its onOpenAutoFocus handler (F4b, #249). A field that always takes
// autoFocus inside its content takes the focus first and breaks the refusal focus, the Tab trap and the Escape return.
// autoFocus={state} stays allowed: it is false when the dialog opens and focuses a field the person just switched to.
const recordDialogFocus = {
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

// Tiptap's free UI components, copied as they are (editor/tiptap/README.md lists each file and its source). They were
// written before the React compiler rules and set state in effects, read refs while rendering and compose refs by
// writing to a local. Rewriting them would make later upstream updates hard to compare, so these three rules stay off
// for that folder only; the Everyfield files around it keep every rule.
const vendoredTiptap = {
	files: ["src/features/documents/church/editor/tiptap/**"],
	rules: {
		"react-hooks/set-state-in-effect": "off",
		"react-hooks/refs": "off",
		"react-hooks/immutability": "off",
	},
};

const config = [
	...nextVitals,
	...nextTs,
	prettier,
	recordDialogFocus,
	vendoredTiptap,
	{ ignores: [".next/**", "next-env.d.ts"] },
];

export default config;
