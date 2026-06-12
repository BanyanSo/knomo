import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

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
	...obsidianmd.configs.recommendedWithLocalesEn,
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
	{
		files: ["package.json"],
		rules: {
			"obsidianmd/no-plugin-as-component": "off",
			"obsidianmd/no-unsupported-api": "off",
			"obsidianmd/no-view-references-in-plugin": "off",
			"obsidianmd/prefer-file-manager-trash-file": "off",
			"obsidianmd/prefer-instanceof": "off",
		},
	},
]);
