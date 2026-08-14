-- Kunden
INSERT INTO customers (id, name, address, billing_type, status) VALUES
 (1,'C1 Basisfall 2025->2026','A','pflegekasse_gesetzlich','aktiv'),
 (2,'C2 Altjahr 2024->2025','A','pflegekasse_gesetzlich','aktiv'),
 (3,'C3 Settings ab Mai 2025','A','pflegekasse_gesetzlich','aktiv'),
 (4,'C4 Startwert 2025','A','pflegekasse_gesetzlich','aktiv'),
 (5,'C5 ohne Pflegegrad-Historie','A','pflegekasse_gesetzlich','aktiv');
SELECT setval('customers_id_seq',100);

-- Pflegegrad-Historie (C5 bewusst ohne)
INSERT INTO customer_care_level_history (customer_id, pflegegrad, valid_from) VALUES
 (1,3,'2020-01-01'),(2,3,'2020-01-01'),(3,3,'2020-01-01'),(4,3,'2020-01-01');

-- §45b-Settings
INSERT INTO customer_budget_type_settings (customer_id, budget_type, enabled, priority, monthly_limit_cents, valid_from, valid_to) VALUES
 (1,'entlastungsbetrag_45b',true,1,NULL,'1970-01-01',NULL),
 (2,'entlastungsbetrag_45b',true,1,NULL,'1970-01-01',NULL),
 (3,'entlastungsbetrag_45b',true,1,NULL,'2025-05-01',NULL),
 (4,'entlastungsbetrag_45b',true,1,NULL,'1970-01-01',NULL),
 (5,'entlastungsbetrag_45b',true,1,NULL,'1970-01-01',NULL);

-- C1: Uebertrag 2025 (1000 EUR, Frist 30.06.2025), Verbrauch 15.09.2025 800 EUR,
--     persistierter Uebertrag 2026 = voller Jahresanspruch 1572 EUR (Phantom 800 EUR)
INSERT INTO budget_allocations (customer_id, budget_type, year, month, amount_cents, source, valid_from, expires_at) VALUES
 (1,'entlastungsbetrag_45b',2025,NULL,100000,'carryover','2025-01-01','2025-06-30'),
 (1,'entlastungsbetrag_45b',2026,NULL,157200,'carryover','2026-01-01','2026-06-30');
INSERT INTO budget_transactions (customer_id, budget_type, transaction_date, transaction_type, amount_cents, appointment_id) VALUES
 (1,'entlastungsbetrag_45b','2025-09-15','consumption',-80000,NULL),
 (1,'entlastungsbetrag_45b','2026-03-01','consumption',-200000,NULL);

-- C2: identisches Muster, aber ein Jahr frueher (Quelljahr 2024 -> Zieljahr 2025).
--     Verbrauch 2025 = 1000 EUR, vollstaendig gedeckt (2025er Anspruch 1572 + Uebertrag 772).
INSERT INTO budget_allocations (customer_id, budget_type, year, month, amount_cents, source, valid_from, expires_at) VALUES
 (2,'entlastungsbetrag_45b',2024,NULL,100000,'carryover','2024-01-01','2024-06-30'),
 (2,'entlastungsbetrag_45b',2025,NULL,157200,'carryover','2025-01-01','2025-06-30');
INSERT INTO budget_transactions (customer_id, budget_type, transaction_date, transaction_type, amount_cents, appointment_id) VALUES
 (2,'entlastungsbetrag_45b','2024-09-15','consumption',-80000,NULL),
 (2,'entlastungsbetrag_45b','2025-03-01','consumption',-100000,NULL);

-- C3: §45b erst ab 01.05.2025 eingerichtet -> Schreibpfad zaehlt 8 Monate (1048 EUR).
--     Uebertrag 2025 500 EUR (Frist 30.06.), Verbrauch 15.09.2025 500 EUR.
--     Schreibpfad persistierte 1048 EUR; halbjahresscharf korrekt waeren 548 EUR -> Phantom 500 EUR.
INSERT INTO budget_allocations (customer_id, budget_type, year, month, amount_cents, source, valid_from, expires_at) VALUES
 (3,'entlastungsbetrag_45b',2025,NULL,50000,'carryover','2025-01-01','2025-06-30'),
 (3,'entlastungsbetrag_45b',2026,NULL,104800,'carryover','2026-01-01','2026-06-30');
INSERT INTO budget_transactions (customer_id, budget_type, transaction_date, transaction_type, amount_cents, appointment_id) VALUES
 (3,'entlastungsbetrag_45b','2025-09-15','consumption',-50000,NULL);

-- C4: Startwert (initial_balance) 2000 EUR im Maerz 2025 -> Jahresanspruch 3441 EUR.
--     Uebertrag 2025 500 EUR, Verbrauch 15.09.2025 600 EUR -> Schreibpfad persistierte 3341 EUR.
--     Halbjahresscharf korrekt: 3441 - 600 = 2841 -> echtes Phantom 500 EUR.
INSERT INTO budget_allocations (customer_id, budget_type, year, month, amount_cents, source, valid_from, expires_at) VALUES
 (4,'entlastungsbetrag_45b',2025,3,200000,'initial_balance','2025-03-01',NULL),
 (4,'entlastungsbetrag_45b',2025,NULL,50000,'carryover','2025-01-01','2025-06-30'),
 (4,'entlastungsbetrag_45b',2026,NULL,334100,'carryover','2026-01-01','2026-06-30');
INSERT INTO budget_transactions (customer_id, budget_type, transaction_date, transaction_type, amount_cents, appointment_id) VALUES
 (4,'entlastungsbetrag_45b','2025-09-15','consumption',-60000,NULL);

-- C5: wie C1, aber ohne Pflegegrad-Historie (Legacy-/Manuell-Anker ueber die Allokationen).
INSERT INTO budget_allocations (customer_id, budget_type, year, month, amount_cents, source, valid_from, expires_at) VALUES
 (5,'entlastungsbetrag_45b',2025,NULL,100000,'carryover','2025-01-01','2025-06-30'),
 (5,'entlastungsbetrag_45b',2026,NULL,157200,'carryover','2026-01-01','2026-06-30');
INSERT INTO budget_transactions (customer_id, budget_type, transaction_date, transaction_type, amount_cents, appointment_id) VALUES
 (5,'entlastungsbetrag_45b','2025-09-15','consumption',-80000,NULL);
