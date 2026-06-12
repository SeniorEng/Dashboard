import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import { SOFT_DELETABLE_TABLE_IDENTS } from "./eslint/soft-deletable-tables.mjs";

// Task #447 / #454 — Soft-Delete zentral durchsetzen. Direktes
// `db.select().from(<soft-deletable-Tabelle>)` in `server/routes/**`,
// `server/storage/**` und `server/services/**` ist verboten, weil dort der
// `deletedAt IS NULL`-Filter regelmäßig vergessen wurde. Aufrufer MÜSSEN
// stattdessen die Repos aus `server/repos/index.ts` nutzen (z.B.
// `customersRepo.findById(id)` oder
// `customersRepo.selectColumnsFrom({...}).where(...)`). Für legitime
// "alles inkl. gelöscht"-Pfade (Audit, GoBD-Historisierung, Cleanup) gibt es
// die `findByIdIncludingDeleted`-Methode bzw. die Datei-spezifischen
// Ausnahmen weiter unten.
// Die Tabellenliste lebt in `eslint/soft-deletable-tables.mjs` als Single
// Source of Truth — `server/repos/index.ts` und der Architektur-Test
// importieren sie ebenfalls dort.

const restrictSoftDeleteFrom = {
  selector:
    `CallExpression[callee.type='MemberExpression'][callee.property.name='from'][arguments.0.type='Identifier'][arguments.0.name=/^(${SOFT_DELETABLE_TABLE_IDENTS.join("|")})$/]`,
  message:
    "Direct `db.select().from(<soft-deletable table>)` is forbidden in server/routes/**, server/storage/** and server/services/**. Use the repo from `server/repos` (e.g. `customersRepo.selectColumnsFrom({...}).where(and(..., customersRepo.activeOnly()))` or `customersRepo.findById(id)`). For legitimate \"including deleted\" reads (audit, GoBD), use `<repo>.findByIdIncludingDeleted` or add a `restrictSoftDeleteFrom`-Override for the file in `eslint.config.js`.",
};

const restrictInvalidateQueries = {
  selector:
    "CallExpression[callee.type='MemberExpression'][callee.property.name='invalidateQueries']",
  message:
    "Direct queryClient.invalidateQueries() is forbidden. Use invalidateRelated() from '@/lib/query-invalidation' to keep cross-domain cache consistency. If a call is intentionally scoped to a single record (e.g. by ID), add an '// invalidate-direct-allowed: <reason>' comment on the line above AND '// eslint-disable-next-line no-restricted-syntax' to opt out.",
};

// BUG-19 (Facette A) — `DEFAULT_BUDGET_POT_ORDER` ist modul-privat in
// `shared/domain/budgets.ts` und liefert nur den UNGEGATETEN Roh-Default
// (§45b an, §45a/§39 aus). Wer den effektiven Default eines Kunden braucht,
// MUSS `effectiveDefaultPots(customer)` nutzen, das den Selbstzahler-/
// Anspruchs-Gate (`defaultStatutoryPotEnabled`) anwendet. Ein direkter Import
// der Konstante umgeht den Gate (z. B. §45b fälschlich für Selbstzahler aktiv)
// und ist deshalb verboten. Cross-Tree-Guard: `tests/architecture/
// budget-default-pots-ssot.test.ts`.
const restrictDefaultPotOrderImport = {
  paths: [
    {
      name: "@shared/domain/budgets",
      importNames: ["DEFAULT_BUDGET_POT_ORDER"],
      message:
        "DEFAULT_BUDGET_POT_ORDER is module-private. Use effectiveDefaultPots(customer) from '@shared/domain/budgets' instead — it applies the Selbstzahler/eligibility gate (defaultStatutoryPotEnabled). A raw import bypasses the gate (e.g. §45b wrongly default-active for Selbstzahler).",
    },
  ],
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
      "no-restricted-imports": ["error", restrictDefaultPotOrderImport],
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
    // Task #447 / #454 — Soft-Delete-Disziplin in Routen, Storage und Services
    files: [
      "server/routes/**/*.{ts,tsx}",
      "server/storage/**/*.{ts,tsx}",
      "server/services/**/*.{ts,tsx}",
    ],
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
      "no-restricted-imports": ["error", restrictDefaultPotOrderImport],
    },
  },
];
