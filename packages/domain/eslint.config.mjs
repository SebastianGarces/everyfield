import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";
export default tseslint.config(...tseslint.configs.recommended, prettier, {
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
});
