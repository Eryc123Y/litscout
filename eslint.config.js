import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "coverage/**",
      ".artifacts/**",
      // Claude Code session worktrees, each a full copy of the repository.
      ".claude/worktrees/**",
    ],
  },
  ...tseslint.configs.recommended,
  { files: ["packages/*/src/**/*.ts"], rules: { "no-console": "error" } },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-empty-function": "off",
    },
  },
);
