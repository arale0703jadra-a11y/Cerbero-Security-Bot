import type { VerifiedUserPermissions } from "../database/repositories/verified-users-repository.js";

export function getVerifiedMessageRestriction(
  permissions: Pick<VerifiedUserPermissions, "can_post" | "can_send_media">,
  hasMedia: boolean,
): "posting_disabled" | "media_disabled" | undefined {
  if (!permissions.can_post) return "posting_disabled";
  if (hasMedia && !permissions.can_send_media) return "media_disabled";
  return undefined;
}

export function shouldSkipOrdinarySpamViolation(
  bypassAntispam: boolean,
  violationType: string,
): boolean {
  if (!bypassAntispam) return false;
  return violationType !== "prohibited_word" && violationType !== "repeat_offender";
}

export function shouldSkipAutomaticDeletion(
  bypassAutomaticDeletion: boolean,
  critical: boolean,
): boolean {
  return bypassAutomaticDeletion && !critical;
}

export function shouldSkipIllegalFilter(
  bypassIllegalFilter: boolean,
  critical: boolean,
): boolean {
  return bypassIllegalFilter && !critical;
}
