import type { BookingStatus } from "../booking/state-machine";

export interface Interval { startAt: Date; endAt: Date }
export interface BookingRules { minMinutes: number; maxMinutes: number; leadMinutes: number }

/** Statuses that hold capacity. An overdue booking still occupies the resource. */
export const HOLDS_CAPACITY: readonly BookingStatus[] = ["approved", "checked_in", "overdue"];

const t = (d: Date): number => d.getTime();

/** Half-open [start, end): back-to-back bookings do not conflict. */
export const overlaps = (a: Interval, b: Interval): boolean =>
  t(a.startAt) < t(b.endAt) && t(b.startAt) < t(a.endAt);

/** Highest number of simultaneous existing bookings inside the window (sweep line). */
export function peakConcurrent(existing: Interval[], window: Interval): number {
  const events: Array<[number, 1 | -1]> = [];
  for (const e of existing) {
    if (!overlaps(e, window)) continue;
    events.push(
      [Math.max(t(e.startAt), t(window.startAt)), 1],
      [Math.min(t(e.endAt), t(window.endAt)), -1],
    );
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]); // at equal instants, ends come first
  let cur = 0;
  let peak = 0;
  for (const [, d] of events) {
    cur += d;
    peak = Math.max(peak, cur);
  }
  return peak;
}

/** Quantity-aware: capacity 1 is an exclusive resource. */
export const hasCapacity = (existing: Interval[], candidate: Interval, capacity: number): boolean =>
  peakConcurrent(existing, candidate) < capacity;

/** Returns an error code, or null when the interval is acceptable. */
export function validateInterval(i: Interval, rules: BookingRules, now: Date): string | null {
  const minutes = (t(i.endAt) - t(i.startAt)) / 60_000;
  if (!Number.isFinite(minutes) || minutes <= 0) return "INVALID_RANGE";
  if (minutes < rules.minMinutes) return "TOO_SHORT";
  if (minutes > rules.maxMinutes) return "TOO_LONG";
  if (t(i.startAt) - t(now) < rules.leadMinutes * 60_000) return "LEAD_TIME";
  return null;
}
