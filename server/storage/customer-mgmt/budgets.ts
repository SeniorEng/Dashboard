// Task #741 + #742: Die Legacy-Tabelle ist als Read-Quelle abgeschaltet
// (SSoT = `customer_budget_type_settings`). Die früheren Read-Helper
// (`getCustomerCurrentBudget`, `getCustomerBudgetHistory`) und der No-Op-
// Writer (`addCustomerBudget`) wurden ersatzlos entfernt. Schreibpfad ist
// jetzt ausschließlich `budgetLedgerStorage.upsertBudgetTypeSettings`.
export {};
