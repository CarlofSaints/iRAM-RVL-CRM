import type { User } from './userData';

/**
 * Shared release/security-code verification with a Super Admin "master code".
 *
 * Background: warehouse actions (booking stock in, releasing stock, reassigning
 * a release, adding boxes) ask for the selected rep/user's 4-char release code
 * to prove that person really did the action. When a Super Admin (e.g. Johann)
 * assists a rep, he shouldn't have to type the rep's PIN — that reads as the rep
 * acting when they didn't, and it forces staff to share codes. Instead a Super
 * Admin may enter their OWN code as a master code to complete the action for any
 * selected rep. Every master-code use is flagged so the audit log records that
 * the Super Admin, not the rep, authorised it.
 */

const SUPER_ADMIN_ROLE = 'super-admin';

function norm(code: string | undefined | null): string {
  return (code ?? '').toUpperCase().trim();
}

export interface ReleaseCodeCheck {
  /** The entered code was accepted (either the target's own code, or a master code). */
  matched: boolean;
  /** True when acceptance came from a Super Admin's own code standing in for the target's. */
  viaMaster: boolean;
}

/**
 * Verify an entered release/security code against the target rep/user's stored
 * code, falling back to the acting Super Admin's own code as a master override.
 *
 * @param entered           the code typed into the form
 * @param targetStoredCode  the selected rep/user's stored releaseCode (may be undefined)
 * @param actor             the logged-in user performing the action (from loadUsers)
 * @param actorRole         guard.userRole
 */
export function verifyReleaseCode(
  entered: string,
  targetStoredCode: string | undefined,
  actor: User | undefined,
  actorRole: string | undefined,
): ReleaseCodeCheck {
  const typed = norm(entered);
  if (!typed) return { matched: false, viaMaster: false };

  const target = norm(targetStoredCode);
  if (target && typed === target) {
    return { matched: true, viaMaster: false };
  }

  // Master code: a Super Admin may complete any rep's action with their own code.
  const actorCode = norm(actor?.releaseCode);
  if (actorRole === SUPER_ADMIN_ROLE && actorCode && typed === actorCode) {
    return { matched: true, viaMaster: true };
  }

  return { matched: false, viaMaster: false };
}

/**
 * Audit suffix appended to the success detail whenever a master code was used,
 * so an investigator can see the Super Admin authorised on the rep's behalf.
 */
export function masterCodeAuditNote(actorName: string, targetName: string): string {
  return ` [MASTER CODE: authorised by Super Admin ${actorName} on behalf of ${targetName}]`;
}
