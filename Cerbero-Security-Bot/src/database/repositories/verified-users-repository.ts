import type { DatabaseClient } from "../client.js";

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
}

export async function getVerifiedUser(
  db: DatabaseClient,
  groupId: number,
  userId: number,
): Promise<VerifiedUserRecord | undefined> {
  const { data, error } = await db
    .from("verified_users")
    .select("*")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .eq("verified", true)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
    if (code === "42P01" || code === "PGRST205") {
      console.warn("[CERBERO] verified_users todavía no está disponible.");
      return undefined;
    }
    throw error;
  }
  return (data as VerifiedUserRecord | null) ?? undefined;
}

export async function getVerifiedUserPermissions(
  db: DatabaseClient,
  groupId: number,
  userId: number,
): Promise<VerifiedUserPermissions | undefined> {
  return (await getVerifiedUser(db, groupId, userId))?.permissions;
}
