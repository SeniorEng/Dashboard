-- Schema-Drift: `employee_vacation_allowance.total_days` ist im Drizzle-Schema seit
-- Längerem als `numeric(5,2)` definiert, in der DB aber noch `integer`. Anteilige
-- Jahresansprüche (z. B. 12.67) führen deshalb beim Insert zu einem
-- "invalid input syntax for type integer"-Fehler.
--
-- Cast von integer auf numeric(5,2) ist verlustfrei.

ALTER TABLE "employee_vacation_allowance"
  ALTER COLUMN "total_days" TYPE numeric(5,2) USING "total_days"::numeric(5,2);
--> statement-breakpoint

ALTER TABLE "employee_vacation_allowance"
  ALTER COLUMN "total_days" SET DEFAULT 30;
