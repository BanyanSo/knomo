import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";

export default defineConfig([
	{
		ignores: [
			"main.js",
			"dist/**",
			"scripts/**",
			"tests/**",
			"*.mjs",
		],
	},
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				project: "./tsconfig.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
]);
