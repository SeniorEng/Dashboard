# Project-Specific Workflows

This file documents the concrete business workflows for CareConnect/SeniorenEngel. Use these as checklists when auditing business logic.

---

## Workflow 1: Termin-Lebenszyklus (Appointment Lifecycle)

### Status Flow:
```
scheduled → in-progress → documenting → completed
```

### Rules:
- Transitions are sequential only (no skipping, no going back)
- Defined in: `shared/domain/appointments.ts` → `isValidStatusTransition()`
- Each status determines which fields are editable:
  - `scheduled`: Scheduling fields (date, time, employee, customer)
  - `documenting`: Documentation fields (durations, notes, signature)
  - `completed`: Nothing editable (locked)

### Critical Data at Each Step:
| Step | User Action | Required Data Set | Common Skip |
|------|------------|-------------------|-------------|
| scheduled → in-progress | Click "Start" | actualStart = now() | YES - users often skip |
| in-progress → documenting | Click "Ende" | actualEnd = now() | YES - users often skip |
| documenting → completed | Submit documentation | All documentation fields, performedByEmployeeId | NO - must complete |

### Fallback Logic (for skipped steps):
- If `actualStart` is NULL at documentation: Set to `scheduledStart`
- If `actualEnd` is NULL at documentation: Set to current time
- Implemented in: `server/routes/appointments.ts` → POST `/:id/document`

### Audit Checklist:
- [ ] Can user document without starting? → Yes, with fallbacks
- [ ] Are actualStart/actualEnd always set for completed appointments? → Yes
- [ ] Is performedByEmployeeId set at documentation? → Yes, from form or current user
- [ ] Does the Leistungsnachweis display actualStart/actualEnd? → Verify
- [ ] Are scheduling fields locked after status leaves "scheduled"? → Verify

---

## Workflow 2: Leistungsnachweis (Service Record)

### Status Flow:
```
(no record) → pending → employee_signed → completed
```

### Prerequisites for Creation:
- ALL appointments for the customer in the given month must be `completed`
- If any appointment is `scheduled`, `in-progress`, or `documenting` → creation blocked
- Defined in: `shared/domain/appointments.ts` → `isAppointmentBlockingServiceRecord()`

### Signature Flow:
1. Leistungsnachweis created → status `pending`
2. Employee signs (digital signature) → status `employee_signed`
3. Customer signs (digital signature) → status `completed`

### Data Shown on Leistungsnachweis:
- Customer name, address, insurance info
- Each appointment: date, times (actualStart/actualEnd), services performed, durations
- Employee name (performedByEmployeeId)
- Both signatures

### Audit Checklist:
- [ ] Are only `completed` appointments included?
- [ ] Does each appointment have actualStart, actualEnd, performedByEmployeeId?
- [ ] Is the blocking check enforced at API level?
- [ ] Is the error message specific about WHICH appointments are undocumented?
- [ ] Can the employee sign before the customer? (Should: Yes)
- [ ] Can the customer sign without employee signature? (Should: No)
- [ ] Is the Leistungsnachweis locked after both signatures?

---

## Workflow 3: Budget-Buchung (§45b Budget Booking)

### Flow:
```
Appointment documented → Cost calculated → Budget transaction created → Balance updated
```

### Cost Calculation:
```
Total = (Hauswirtschaft minutes × hourly rate / 60)
      + (Alltagsbegleitung minutes × hourly rate / 60)
      + (travel km × km rate)
      + (customer km × customer km rate)
```
- Rates come from: `customer_pricing_history` (active record with `valid_to IS NULL`)
- Defined in: `server/services/appointments.ts`

### Budget Sources (Credits):
- `monthly`: 125€/month (since 2024: 131€)
- `carryover`: Previous year's unused budget (expires June 30 of following year)
- `initial_balance`: When customer first joins
- `manual_adjustment`: Admin corrections

### Audit Checklist:
- [ ] Does documenting an appointment create a budget transaction?
- [ ] Does the transaction amount match the cost calculation?
- [ ] Is a valid pricing agreement required? (Should: Yes, block if missing)
- [ ] Does reversing/undoing an appointment reverse the budget transaction?
- [ ] Does the balance display correctly (allocations - transactions)?
- [ ] Is the carryover expiry (June 30) enforced?
- [ ] Is the monthly limit preference respected?
- [ ] Are all monetary values stored in cents (integer)?

---

## Workflow 4: Zeiterfassung (Time Tracking)

### Entry Types:
- `urlaub` (vacation), `krankheit` (sick), `pause` (break)
- `bueroarbeit` (office), `vertrieb` (sales), `schulung` (training)
- `besprechung` (meeting), `sonstiges` (other)

### Rules:
- Time entries linked to employee via `userId`
- Past entries are locked for non-admin users
- Full-day entries (vacation, sick) don't require start/end times
- Break documentation required by German labor law (§4 ArbZG):
  - >6 hours work → 30 min break required
  - >9 hours work → 45 min break required

### Audit Checklist:
- [ ] Can non-admin users edit past entries? (Should: No)
- [ ] Is break requirement detected based on actual work hours?
- [ ] Does the open tasks system alert about missing break documentation?
- [ ] Is vacation allowance tracked per year per employee?
- [ ] Do multi-day entries create correct records for each day?
- [ ] Are appointment times included in daily work hour calculation?

---

## Workflow 5: Kundenverwaltung (Customer Management)

### Creation Flow:
Multi-step form with sections:
1. Personal data (name, contact, birthday)
2. Address
3. Insurance (Pflegekasse, IK-Nummer, Versichertennummer)
4. Care level (Pflegegrad 1-5)
5. Employee assignment (primary + backup)
6. Pricing agreement (hourly rates)

### Historized Fields (valid_from/valid_to pattern):
- Care level → `customer_care_level_history`
- Insurance → `customer_insurance_history`
- Pricing → `customer_pricing_history`
- Employee assignment → `customer_assignment_history`
- Compensation → `employee_compensation_history`

### Audit Checklist:
- [ ] Does changing care level create a new history record (not update existing)?
- [ ] Does the current care level query filter by `valid_to IS NULL`?
- [ ] Can a customer have two active assignments for the same role? (Should: No)
- [ ] Is the IK-Nummer validated (9 digits)?
- [ ] Are phone numbers stored in E.164 format (+49...)?
- [ ] Is the birthday used for birthday reminder dashboard?
- [ ] Soft-delete: Does deactivating a customer hide them from normal lists?

---

## Workflow 6: Mitarbeiter-Zuweisung (Employee Assignment)

### Rules:
- Each customer has a primary and optional backup employee
- Changes are historized in `customer_assignment_history`
- Assignment determines who sees the customer in their dashboard
- performedByEmployeeId on appointments tracks who actually performed the work

### Audit Checklist:
- [ ] Does reassignment create new history record + expire old one?
- [ ] Does the appointment form show only valid employees?
- [ ] Can performedByEmployeeId differ from assignedEmployeeId? (Should: Yes)
- [ ] Does the Leistungsnachweis show the performer, not the assigned employee?
- [ ] Are deactivated employees excluded from assignment options?

---

## Cross-Workflow Dependencies

Use this dependency map when auditing cross-feature impact:

```
Customer Created
  └→ Care Level History entry
  └→ Insurance History entry
  └→ Employee Assignment History entry
  └→ Pricing Agreement History entry
  └→ Budget Preferences set

Appointment Created
  └→ Assigned Employee set
  └→ Scheduled times set

Appointment Documented (→ completed)
  └→ actualStart/actualEnd set (with fallbacks)
  └→ performedByEmployeeId set
  └→ Duration fields finalized
  └→ Budget transaction created (cost booked)
  └→ Time tracking hours derived

Leistungsnachweis Created
  └→ Requires: ALL appointments in month are `completed`
  └→ Shows: actualStart/actualEnd, performer, durations
  └→ Signature workflow: employee → customer → locked

Budget Checked
  └→ Requires: Active allocations (monthly, carryover)
  └→ Tracks: Consumption transactions from appointments
  └→ Warns: Monthly limit approached, carryover expiring
```
