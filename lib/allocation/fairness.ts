import type { BookingStatus } from "../booking/state-machine";
import { overlaps } from "../availability/capacity";
import type { Interval } from "../availability/capacity";

export interface Policy {
  maxActivePerUser: number;
  quotaWindowDays: number;
  quotaMinutes: number;
  maxCancellationsInWindow: number;
  usageWeight: number;   // priority points lost per hour of recent usage
  cancelPenalty: number; // priority points lost per recent cancellation
}
export interface UserBooking extends Interval { status: BookingStatus; cancelledAt?: Date }
export interface WaitEntry {
  id: string;
  requesterId: string;
  createdAt: Date;
  usageMinutes: number;
  recentCancellations: number;
}
export type Denial = "OVERLAPS_OWN_BOOKING" | "ACTIVE_LIMIT" | "QUOTA_EXCEEDED" | "CANCELLATION_LIMIT";

const DAY = 86_400_000;
const ACTIVE: readonly BookingStatus[] = ["requested", "approved", "checked_in", "overdue"];
const USED: readonly BookingStatus[] = [...ACTIVE, "returned", "incident_review"];
const mins = (i: Interval): number => (i.endAt.getTime() - i.startAt.getTime()) / 60_000;

export function recentCancellations(history: UserBooking[], p: Policy, now: Date): number {
  const since = now.getTime() - p.quotaWindowDays * DAY;
  return history.filter((b) => b.status === "cancelled" && b.cancelledAt && b.cancelledAt.getTime() >= since).length;
}

/**
 * Fair-use checks in a fixed order so the denial reason is deterministic and explainable.
 * The quota window is centred on the requested slot (+/- quotaWindowDays), which is
 * deliberately conservative: booking far-future slots first cannot dodge it.
 */
export function checkFairUse(candidate: Interval, history: UserBooking[], p: Policy, now: Date): Denial | null {
  const active = history.filter((b) => ACTIVE.includes(b.status));
  if (active.some((b) => overlaps(b, candidate))) return "OVERLAPS_OWN_BOOKING";
  if (active.length >= p.maxActivePerUser) return "ACTIVE_LIMIT";
  const span = p.quotaWindowDays * DAY;
  const used = history
    .filter((b) => USED.includes(b.status) && Math.abs(b.startAt.getTime() - candidate.startAt.getTime()) <= span)
    .reduce((sum, b) => sum + mins(b), 0);
  if (used + mins(candidate) > p.quotaMinutes) return "QUOTA_EXCEEDED";
  if (recentCancellations(history, p, now) >= p.maxCancellationsInWindow) return "CANCELLATION_LIMIT";
  return null;
}

/** Baseline: start at 100; lighter recent usage ranks higher; cancel-and-rebook is penalised. */
export const priorityScore = (e: WaitEntry, p: Policy): number =>
  Math.round((100 - (e.usageMinutes / 60) * p.usageWeight - e.recentCancellations * p.cancelPenalty) * 1e6) / 1e6;

/** Score desc, then earliest request, then id: fully deterministic. */
export function orderWaitlist(entries: WaitEntry[], p: Policy): WaitEntry[] {
  return [...entries].sort(
    (a, b) =>
      priorityScore(b, p) - priorityScore(a, p) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** First entry in priority order that fits the freed slot; others keep their place. */
export const nextToPromote = (entries: WaitEntry[], p: Policy, fits: (e: WaitEntry) => boolean): WaitEntry | null =>
  orderWaitlist(entries, p).find(fits) ?? null;
