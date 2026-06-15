// @ts-check
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

const sourceFiles = ["apps/**/src/**/*.ts", "packages/**/src/**/*.ts"];
const recommendedTypeCheckedAsWarnings = tseslint.configs.recommendedTypeChecked.map((config) => ({
  ...config,
  files: sourceFiles,
  rules: Object.fromEntries(Object.keys(config.rules ?? {}).map((rule) => [rule, "warn"]))
}));

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".turbo/**",
      "Synapse/**",
      "scripts/**",
      "**/*.mjs",
      "**/*.cjs"
    ]
  },
  ...recommendedTypeCheckedAsWarnings,
  {
    files: sourceFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // Existing async hazards are advisory until the codebase is clean.
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
      // Everything else from recommendedTypeChecked stays advisory for now.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn"
    }
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  prettier
);
