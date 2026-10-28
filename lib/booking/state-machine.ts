export const BOOKING_STATUSES = [
  "requested", "approved", "checked_in", "returned",
  "rejected", "waitlisted", "cancelled", "overdue", "incident_review",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

// Single source of truth for legal transitions. Waitlist promotion re-enters
// "requested" so eligibility and conflicts are re-checked before approval.
const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  requested: ["approved", "rejected", "waitlisted", "cancelled"],
  waitlisted: ["requested", "cancelled"],
  approved: ["checked_in", "cancelled"],
  checked_in: ["returned", "overdue", "incident_review"],
  overdue: ["returned", "incident_review"],
  returned: ["incident_review"],
  incident_review: ["returned"],
  rejected: [],
  cancelled: [],
};

export class IllegalTransitionError extends Error {
  constructor(from: BookingStatus, to: BookingStatus) {
    super(`Illegal booking transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export const canTransition = (from: BookingStatus, to: BookingStatus): boolean =>
  TRANSITIONS[from].includes(to);

/** Returns a copy with previousStatus kept, so an overdue booking's history survives its return. */
export function transition<T extends { status: BookingStatus }>(
  booking: T,
  to: BookingStatus,
): T & { previousStatus: BookingStatus } {
  if (!canTransition(booking.status, to)) throw new IllegalTransitionError(booking.status, to);
  return { ...booking, previousStatus: booking.status, status: to };
}
