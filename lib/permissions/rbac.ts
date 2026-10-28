export type Role = "user" | "owner" | "manager" | "admin";
export type Action =
  | "resource:view" | "resource:update"
  | "booking:create" | "booking:decide" | "booking:cancel" | "booking:confirm_return"
  | "incident:resolve" | "audit:read" | "user:setRole";
export interface Actor { id: string; roles: Role[]; institutionId: string; suspended?: boolean }
export interface Target { institutionId: string; ownerId?: string; requesterId?: string; subjectId?: string }

/** Call from every route handler / server action; never rely on hidden UI. */
export function can(actor: Actor, action: Action, t: Target): boolean {
  if (actor.suspended) return false;
  if (action === "booking:decide" && t.requesterId === actor.id) return false; // no self-approval
  if (action === "user:setRole" && t.subjectId === actor.id) return false;     // no self-promotion
  const is = (r: Role): boolean => actor.roles.includes(r);
  if (is("admin")) return true;
  if (t.institutionId !== actor.institutionId) return false; // institution isolation
  switch (action) {
    case "resource:view":
    case "booking:create":
      return true;
    case "resource:update":
    case "booking:decide":
    case "booking:confirm_return":
      return is("manager") || (is("owner") && t.ownerId === actor.id);
    case "booking:cancel":
      return t.requesterId === actor.id || is("manager");
    case "incident:resolve":
    case "audit:read":
      return is("manager");
    default:
      return false; // user:setRole and anything unknown: admin only
  }
}
