import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import { SOFT_DELETABLE_TABLE_IDENTS } from "./eslint/soft-deletable-tables.mjs";

// Task #447 — Soft-Delete zentral durchsetzen. Direktes
// `db.select().from(<soft-deletable-Tabelle>)` in `server/routes/**` ist
// verboten, weil dort der `deletedAt IS NULL`-Filter regelmäßig vergessen
// wurde. Routen MÜSSEN stattdessen die Repos aus `server/repos/index.ts`
// nutzen (z.B. `customersRepo.findById(id)` oder
// `customersRepo.selectColumnsFrom({...}).where(...)`).
// Die Tabellenliste lebt in `eslint/soft-deletable-tables.mjs` als Single
// Source of Truth — `server/repos/index.ts` und der Architektur-Test
// importieren sie ebenfalls dort.

const restrictSoftDeleteFrom = {
  selector:
    `CallExpression[callee.type='MemberExpression'][callee.property.name='from'][arguments.0.type='Identifier'][arguments.0.name=/^(${SOFT_DELETABLE_TABLE_IDENTS.join("|")})$/]`,
  message:
    "Direct `db.select().from(<soft-deletable table>)` is forbidden in server/routes/**. Use the repo from `server/repos` (e.g. `customersRepo.selectColumnsFrom({...}).where(and(..., customersRepo.activeOnly()))` or `customersRepo.findById(id)`). The repo enforces `deletedAt IS NULL` so soft-deleted rows never leak into operational views.",
};

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
  {
    // Task #447 — Soft-Delete-Disziplin in Routen
    files: ["server/routes/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    rules: {
      "no-restricted-syntax": ["error", restrictSoftDeleteFrom],
    },
  },
];
