import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";
import globals from "globals";
import vue from "eslint-plugin-vue";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["dist/**", "coverage/**", "web-dist/**"],
  },
  {
    files: ["src/**/*.ts", "web/src/**/*.ts", "vite.config.ts", "tests/**/*.mjs", "eslint.config.mjs"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      stylistic.configs.customize({
        indent: 2,
        quotes: "double",
        semi: true,
        jsx: false,
      }),
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  { files: ["tests/browser/**/*.mjs"], languageOptions: { globals: globals.browser } },
  ...vue.configs["flat/recommended"],
  { files: ["web/src/**/*.vue"], languageOptions: { parserOptions: { parser: tseslint.parser }, globals: globals.browser }, rules: { "vue/multi-word-component-names": "off", "vue/max-attributes-per-line": "off" } },
);
