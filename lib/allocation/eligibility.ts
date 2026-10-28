export type VerificationStatus = "pending" | "verified" | "rejected" | "expired";
export interface Verification { requirementType: string; status: VerificationStatus; expiryAt?: Date }

/** Expiry is judged at the END of the booking: a qualification lapsing mid-booking does not qualify. */
export function checkEligibility(
  required: string[],
  held: Verification[],
  bookingEnd: Date,
): { eligible: boolean; missing: string[] } {
  const valid = (r: string): boolean =>
    held.some(
      (v) =>
        v.requirementType === r &&
        v.status === "verified" &&
        (!v.expiryAt || v.expiryAt.getTime() > bookingEnd.getTime()),
    );
  const missing = required.filter((r) => !valid(r));
  return { eligible: missing.length === 0, missing };
}
