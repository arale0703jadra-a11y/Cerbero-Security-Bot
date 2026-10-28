import type { DatabaseClient } from "../client.js";
import { withControlledRetries } from "../../services/resilience.js";

export interface VerifiedUserPermissions {
  can_post: boolean;
  can_send_media: boolean;
  can_send_links: boolean;
  bypass_antispam: boolean;
  bypass_promotion_filter: boolean;
  bypass_illegal_filter: boolean;
  bypass_automatic_deletion: boolean;
}

export interface VerifiedUserRecord {
  id: string;
  group_id: number;
  user_id: number;
  username: string | null;
  display_name: string | null;
  verified: boolean;
  permissions: VerifiedUserPermissions;
  created_at: string;
  updated_at: string;
  created_by: number | null;
  revoked_at: string | null;
  valid_until?: string | null;
}

// Keep these defaults aligned with ZEUS DEFAULT_VERIFIED_PERMISSIONS.
export const DEFAULT_VERIFIED_USER_PERMISSIONS: VerifiedUserPermissions = {
  can_post: true,
  can_send_media: true,
  can_send_links: true,
  bypass_antispam: false,
  bypass_promotion_filter: false,
  bypass_illegal_filter: false,
  bypass_automatic_deletion: false,
};

export function normalizeVerifiedUserPermissions(
  value: unknown,
): VerifiedUserPermissions {
  const normalized = { ...DEFAULT_VERIFIED_USER_PERMISSIONS };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return normalized;
  }
  const permissions = value as Record<string, unknown>;
  for (const key of Object.keys(normalized) as Array<keyof VerifiedUserPermissions>) {
    if (typeof permissions[key] === "boolean") {
      normalized[key] = permissions[key];
    }
  }
  return normalized;
}

export async function getVerifiedUser(
  db: DatabaseClient,
  groupId: number,
  userId: number,
  now = new Date(),
): Promise<VerifiedUserRecord | undefined> {
  let data: unknown;
  try {
    data = await withControlledRetries(async () => {
      const { data, error } = await db
        .from("verified_users")
        .select("*")
        .eq("group_id", groupId)
        .eq("user_id", userId)
        .eq("verified", true)
        .is("revoked_at", null)
        .maybeSingle();
      if (error) throw error;
      return data;
    }, { maxAttempts: 3, baseDelayMs: 150, maxDelayMs: 600 });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
    if (code === "42P01" || code === "PGRST205") {
      console.warn("[CERBERO] verified_users todavía no está disponible.");
      return undefined;
    }
    throw error;
  }
  if (!data) return undefined;
  const record = data as VerifiedUserRecord;
  if (record.verified !== true || record.revoked_at !== null) return undefined;
  if (record.valid_until != null) {
    if (typeof record.valid_until !== "string") return undefined;
    const validUntil = Date.parse(record.valid_until);
    if (!Number.isFinite(validUntil) || validUntil <= now.getTime()) {
      return undefined;
    }
  }
  return {
    ...record,
    permissions: normalizeVerifiedUserPermissions(record.permissions),
  };
}

export async function getVerifiedUserPermissions(
  db: DatabaseClient,
  groupId: number,
  userId: number,
  now = new Date(),
): Promise<VerifiedUserPermissions | undefined> {
  return (await getVerifiedUser(db, groupId, userId, now))?.permissions;
}
