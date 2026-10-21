import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";
export default tseslint.config(...tseslint.configs.recommended, prettier);
