import prettier from "eslint-config-prettier/flat";
import oxlint from "eslint-plugin-oxlint";
import tseslint from "typescript-eslint";
// Oxlint runs first in `pnpm lint` (../../.oxlintrc.json) and enforces every recommended rule; eslint-plugin-oxlint turns
// those off here. ESLint stays for the rule Oxlint lacks: the selector below.
export default tseslint.config(
	...tseslint.configs.recommended,
	prettier,
	{
		files: ["src/**/*.ts"],
		// Independent health probes and the HTTP telemetry deadline share no transaction.
		ignores: ["src/operations/health.ts", "src/operations/telemetry.ts"],
		rules: {
			"no-restricted-syntax": [
				"error",
				{
					selector: "CallExpression[callee.object.name='Promise'][callee.property.name=/^(all|allSettled|race|any)$/]",
					message:
						"Await domain queries sequentially. Batch rows in SQL instead of running promises on a shared transaction.",
				},
			],
		},
	},
	...oxlint.buildFromOxlintConfigFile(`${import.meta.dirname}/../../.oxlintrc.json`),
	// A disable comment names a rule of one tool, and the other tool reports it as unused, so neither reports them.
	{ name: "oxlint/disable-comments", linterOptions: { reportUnusedDisableDirectives: "off" } },
);
