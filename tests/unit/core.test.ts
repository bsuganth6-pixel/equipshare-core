import { describe, expect, it } from "vitest";
import { canTransition, IllegalTransitionError, transition } from "../../lib/booking/state-machine";
import type { BookingStatus } from "../../lib/booking/state-machine";
import { hasCapacity, overlaps, validateInterval } from "../../lib/availability/capacity";
import { checkEligibility } from "../../lib/allocation/eligibility";
import type { Verification } from "../../lib/allocation/eligibility";
import { checkFairUse, nextToPromote, orderWaitlist } from "../../lib/allocation/fairness";
import type { Policy, UserBooking, WaitEntry } from "../../lib/allocation/fairness";
import { can } from "../../lib/permissions/rbac";
import type { Actor, Role } from "../../lib/permissions/rbac";

const H = 3_600_000;
const T0 = new Date("2026-11-02T09:00:00Z");
const at = (h: number) => new Date(T0.getTime() + h * H);
const slot = (a: number, b: number) => ({ startAt: at(a), endAt: at(b) });

describe("booking state machine", () => {
  it("allows the happy path", () => {
    let b: { status: BookingStatus } = { status: "requested" };
    for (const s of ["approved", "checked_in", "returned"] as const) b = transition(b, s);
    expect(b.status).toBe("returned");
  });
  it("rejects arbitrary jumps and terminal exits", () => {
    expect(() => transition({ status: "requested" }, "returned")).toThrow(IllegalTransitionError);
    expect(canTransition("rejected", "approved")).toBe(false);
    expect(canTransition("cancelled", "requested")).toBe(false);
  });
  it("keeps history when an overdue booking is returned", () => {
    expect(transition({ status: "overdue" }, "returned").previousStatus).toBe("overdue");
  });
});

describe("availability", () => {
  it("treats back-to-back bookings as non-overlapping", () => {
    expect(overlaps(slot(0, 2), slot(2, 4))).toBe(false);
    expect(overlaps(slot(0, 3), slot(2, 4))).toBe(true);
  });
  it("blocks overlaps on exclusive resources", () => {
    expect(hasCapacity([slot(0, 2)], slot(1, 3), 1)).toBe(false);
    expect(hasCapacity([slot(0, 2)], slot(2, 3), 1)).toBe(true);
  });
  it("tracks quantity by peak concurrency, not overlap count", () => {
    expect(hasCapacity([slot(0, 2), slot(2, 4)], slot(1, 3), 2)).toBe(true); // never simultaneous
    const busy = [slot(0, 3), slot(1, 4)];
    expect(hasCapacity(busy, slot(1, 3), 2)).toBe(false);
    expect(hasCapacity(busy, slot(1, 3), 3)).toBe(true);
  });
  it("validates range, duration and lead time", () => {
    const rules = { minMinutes: 30, maxMinutes: 240, leadMinutes: 60 };
    const short = { startAt: at(0), endAt: new Date(at(0).getTime() + 10 * 60_000) };
    expect(validateInterval(slot(2, 1), rules, at(-2))).toBe("INVALID_RANGE");
    expect(validateInterval(short, rules, at(-2))).toBe("TOO_SHORT");
    expect(validateInterval(slot(0, 5), rules, at(-2))).toBe("TOO_LONG");
    expect(validateInterval(slot(0, 2), rules, at(-0.5))).toBe("LEAD_TIME");
    expect(validateInterval(slot(0, 2), rules, at(-2))).toBeNull();
  });
});

describe("eligibility", () => {
  const v = (requirementType: string, status: Verification["status"], expiryAt?: Date): Verification => ({
    requirementType, status, expiryAt,
  });
  it("needs verified qualifications that outlast the booking", () => {
    const end = at(2);
    expect(checkEligibility(["laser"], [v("laser", "verified", at(10))], end).eligible).toBe(true);
    expect(checkEligibility(["laser"], [v("laser", "verified", at(1))], end).missing).toEqual(["laser"]);
    expect(checkEligibility(["laser"], [v("laser", "pending")], end).eligible).toBe(false);
    expect(checkEligibility(["laser"], [v("laser", "rejected")], end).eligible).toBe(false);
    expect(checkEligibility([], [], end).eligible).toBe(true);
  });
});

const policy: Policy = {
  maxActivePerUser: 2, quotaWindowDays: 7, quotaMinutes: 480,
  maxCancellationsInWindow: 3, usageWeight: 2, cancelPenalty: 10,
};
const now = at(-24);
const bk = (a: number, b: number, status: BookingStatus = "approved"): UserBooking => ({ ...slot(a, b), status });

describe("fair use", () => {
  it("denies overlaps with the user's own bookings", () => {
    expect(checkFairUse(slot(1, 3), [bk(0, 2)], policy, now)).toBe("OVERLAPS_OWN_BOOKING");
  });
  it("caps simultaneous active bookings", () => {
    expect(checkFairUse(slot(30, 31), [bk(0, 1), bk(10, 11)], policy, now)).toBe("ACTIVE_LIMIT");
  });
  it("enforces the rolling quota and ignores usage outside the window", () => {
    const recent = bk(-12, -6, "returned"); // 6 h inside the window
    const old = bk(-250, -244, "returned"); // > 7 days away
    expect(checkFairUse(slot(0, 3), [recent], policy, now)).toBe("QUOTA_EXCEEDED");
    expect(checkFairUse(slot(0, 2), [recent], policy, now)).toBeNull();
    expect(checkFairUse(slot(0, 3), [old], policy, now)).toBeNull();
  });
  it("blocks repeated cancel-and-rebook", () => {
    const c = (h: number): UserBooking => ({ ...slot(h, h + 1), status: "cancelled", cancelledAt: at(-30) });
    expect(checkFairUse(slot(50, 51), [c(0), c(5), c(10)], policy, now)).toBe("CANCELLATION_LIMIT");
    expect(checkFairUse(slot(50, 51), [c(0), c(5)], policy, now)).toBeNull();
  });
});

describe("waitlist", () => {
  const e = (id: string, createdH: number, usageMinutes = 0, recentCancellations = 0): WaitEntry => ({
    id, requesterId: id, createdAt: at(createdH), usageMinutes, recentCancellations,
  });
  it("ranks lighter users first, then earlier requests, then id", () => {
    const order = orderWaitlist([e("c", 2), e("a", 1, 600), e("b", 1), e("d", 2)], policy).map((x) => x.id);
    expect(order).toEqual(["b", "c", "d", "a"]);
  });
  it("does not reward cancel-and-rebook", () => {
    expect(orderWaitlist([e("x", 1, 0, 1), e("y", 3)], policy).map((x) => x.id)).toEqual(["y", "x"]);
  });
  it("promotes the first entry that fits the freed slot", () => {
    expect(nextToPromote([e("a", 1), e("b", 2)], policy, (x) => x.id !== "a")?.id).toBe("b");
    expect(nextToPromote([e("a", 1)], policy, () => false)).toBeNull();
  });
});

describe("permissions", () => {
  const actor = (roles: Role[], id = "u1", institutionId = "inst1", suspended = false): Actor => ({
    id, roles, institutionId, suspended,
  });
  const target = { institutionId: "inst1", ownerId: "own1", requesterId: "u9" };
  it("lets only the owning owner or a manager decide requests", () => {
    expect(can(actor(["owner"], "own1"), "booking:decide", target)).toBe(true);
    expect(can(actor(["owner"], "other"), "booking:decide", target)).toBe(false);
    expect(can(actor(["manager"], "m1"), "booking:decide", target)).toBe(true);
    expect(can(actor(["user"], "u1"), "booking:decide", target)).toBe(false);
  });
  it("blocks self-approval", () => {
    expect(can(actor(["owner"], "own1"), "booking:decide", { ...target, requesterId: "own1" })).toBe(false);
  });
  it("isolates institutions", () => {
    expect(can(actor(["manager"], "m1", "inst2"), "audit:read", target)).toBe(false);
    expect(can(actor(["manager"], "m1"), "audit:read", target)).toBe(true);
  });
  it("limits role changes to admins, never self, and denies suspended accounts", () => {
    const t = (subjectId: string) => ({ institutionId: "inst1", subjectId });
    expect(can(actor(["manager"]), "user:setRole", t("u2"))).toBe(false);
    expect(can(actor(["admin"], "a1"), "user:setRole", t("u2"))).toBe(true);
    expect(can(actor(["admin"], "a1"), "user:setRole", t("a1"))).toBe(false);
    expect(can(actor(["admin"], "a1", "inst1", true), "audit:read", target)).toBe(false);
  });
});
