---
name: Private-pot eligibility gate (Selbstzahler 19%)
description: Where the "may this customer get a private/Selbstzahler 19% pot/invoice?" decision must be enforced, and why it leaked.
---

Whether a customer may receive a private (Selbstzahler, 19% USt) budget pot / invoice is ONE
decision: `isPrivatePaymentAllowed({billingType, acceptsPrivatePayment})` in
`shared/domain/budget-selbstzahler-validator.ts` (true iff selbstzahler billingType OR
`acceptsPrivatePayment === true`).

**Why:** A Pflegekasse customer (`acceptsPrivatePayment=false`, not selbstzahler) once wrongly
got a private 19% invoice next to the correct Kassen invoice. Root cause: the private-pot
eligibility check was duplicated across several write paths and one of them (net-zero rebook)
had NO gate — it always re-booked any remaining cents into a private pot.

**How to apply:** Any new code path that can mint a private pot / private line items must call
the shared helper, never re-derive the rule. Enforcement points to keep consistent:
- consumption-engine (normal booking cascade)
- reservation-storage (private capability)
- appointment-import (`loadPrivatePaymentAllowed`)
- rebook-storage net-zero rebook (build the private pot CONDITIONALLY, like the booking path;
  if a real rest remains for a non-private customer, hard-block naming the appointmentIds)
- invoice-calc `splitLineItemsByPot({ allowPrivatePot })` = BACKSTOP: throws (naming the
  appointmentIds) if a non-self-payer ends up with a non-zero private share; this also guards
  the read/preview path, which is acceptable.

Preserve: selbstzahler + `acceptsPrivatePayment=true`, incl. budget=0 ⇒ exactly ONE private
invoice.
