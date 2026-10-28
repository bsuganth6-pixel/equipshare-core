# EquipShare core (deterministic domain logic)

Framework-free TypeScript for `lib/` in the Next.js repo. No dependencies.

- `booking/state-machine.ts`: the only place legal status transitions live
- `availability/capacity.ts`: half-open intervals, quantity-aware conflicts, duration and lead-time rules
- `allocation/eligibility.ts`: verification and expiry (judged at booking end)
- `allocation/fairness.ts`: fair-use limits, priority score, waitlist order and promotion
- `permissions/rbac.ts`: role + institution scoped checks; call from every route/action

Test: `npx vitest run`

Not included: UI, Auth.js, Mongoose models/indexes, MongoDB transactions (these pure
checks cannot stop two concurrent requests alone; re-run them inside a transaction or
guarded write at confirmation), audit log, notifications, uploads, e2e tests, CI.
The quota window and priority weights are a documented baseline, not a claim of perfect fairness.
