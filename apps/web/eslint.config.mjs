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

const config = [...nextVitals, ...nextTs, prettier, recordDialogFocus, { ignores: [".next/**", "next-env.d.ts"] }];

export default config;
