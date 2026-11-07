import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["dist/**", "coverage/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.mjs", "eslint.config.mjs"],
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
);
