import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

const restrictInvalidateQueries = {
  selector:
    "CallExpression[callee.type='MemberExpression'][callee.property.name='invalidateQueries']",
  message:
    "Direct queryClient.invalidateQueries() is forbidden. Use invalidateRelated() from '@/lib/query-invalidation' to keep cross-domain cache consistency. If a call is intentionally scoped to a single record (e.g. by ID), add an '// invalidate-direct-allowed: <reason>' comment on the line above AND '// eslint-disable-next-line no-restricted-syntax' to opt out.",
};

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "client/dist/**",
      "**/*.config.{js,ts,mjs,cjs}",
    ],
  },
  {
    files: ["client/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    rules: {
      "no-restricted-syntax": ["error", restrictInvalidateQueries],
      "react-hooks/rules-of-hooks": "error",
    },
  },
  {
    files: ["client/src/lib/query-invalidation.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];
