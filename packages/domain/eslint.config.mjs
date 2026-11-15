import prettier from "eslint-config-prettier/flat";
import oxlint from "eslint-plugin-oxlint";
import tseslint from "typescript-eslint";
export default tseslint.config(
	...tseslint.configs.recommended,
	prettier,
	{
		name: "Domain queries run one after another on a shared transaction; the independent health probes and the HTTP telemetry deadline share none",
		files: ["src/**/*.ts"],
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
	{
		name: "oxlint/disable-comments: a disable comment names a rule of one tool and the other reports it unused",
		linterOptions: { reportUnusedDisableDirectives: "off" },
	},
);
