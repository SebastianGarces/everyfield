import tseslint from 'typescript-eslint';
export default tseslint.config({ignores:['src/artifacts.json','src/freeze.json']}, ...tseslint.configs.recommended);
