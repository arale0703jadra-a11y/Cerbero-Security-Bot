import type { DatabaseClient } from "../client.js";
import type { SecurityGroupConfig } from "../types.js";
import {
  getServiceHealth,
  recordServiceHealth,
  withControlledRetries,
} from "../../services/resilience.js";

const defaults: Omit<SecurityGroupConfig, "group_id"> = {
  enabled: true,
  safe_mode: false,
  sanctions_enabled: true,
  mode: "alert",
  anti_spam: true,
  anti_flood: true,
  anti_links: true,
  anti_content: true,
  media_protection: true,
  prohibited_words: [],
  allowed_link_domains: [],
  warning_two_action: "mute",
  warning_three_action: "kick",
  warning_four_action: "ban",
  reincidence_enabled: true,
  rules: {},
  sticker_limit: 5,
  media_limit: 8,
};

export async function getSecurityConfig(
  db: DatabaseClient,
  groupId: number,
): Promise<SecurityGroupConfig> {
  const { data, error } = await db
    .from("security_group_configs")
    .select("*")
    .eq("group_id", groupId)
    .maybeSingle();
  if (error) throw error;
  if (data) {
    return {
      ...defaults,
      ...data,
      prohibited_words: Array.isArray(data.prohibited_words) ? data.prohibited_words : [],
      allowed_link_domains: Array.isArray(data.allowed_link_domains) ? data.allowed_link_domains : [],
      rules: data.rules && typeof data.rules === "object" ? data.rules : {},
    } as SecurityGroupConfig;
  }
  const { data: created, error: createError } = await db
    .from("security_group_configs")
    .insert({ group_id: groupId, ...defaults })
    .select("*")
    .single();
  if (createError) throw createError;
  return created as SecurityGroupConfig;
}

export async function getSecurityConfigResilient(
  db: DatabaseClient,
  groupId: number,
): Promise<SecurityGroupConfig> {
  try {
    const result = await withControlledRetries(
      () => getSecurityConfig(db, groupId),
      { maxAttempts: 3, baseDelayMs: 150, maxDelayMs: 600 },
    );
    recordServiceHealth("security-config");
    return result;
  } catch (error) {
    recordServiceHealth("security-config", error);
    const health = getServiceHealth("security-config");
    console.error(
      `[CERBERO] security config unavailable groupId=${groupId}; ` +
        `health=degraded errorClass=${health.lastErrorClass}; detection remains enabled, ` +
        `sanctions enforcement is disabled until configuration access recovers.`,
    );
    return {
      ...defaults,
      group_id: groupId,
      enabled: true,
      safe_mode: true,
      sanctions_enabled: false,
      mode: "alert",
      rules: {
        flood: { enabled: false, severity: "high", action: "detect" },
        spam_repeated: { enabled: false, severity: "medium", action: "detect" },
        excessive_links: { enabled: false, severity: "medium", action: "detect" },
        sticker_spam: { enabled: false, severity: "medium", action: "detect" },
        media_spam: { enabled: false, severity: "medium", action: "detect" },
        media: { enabled: false, severity: "high", action: "detect" },
        prohibited_word: { enabled: false, severity: "high", action: "detect" },
        repeat_offender: { enabled: false, severity: "high", action: "detect" },
      },
    };
  }
}

export async function updateSecurityConfig(
  db: DatabaseClient,
  groupId: number,
  changes: Partial<Omit<SecurityGroupConfig, "group_id">>,
): Promise<SecurityGroupConfig> {
  await getSecurityConfig(db, groupId);
  const { data, error } = await db
    .from("security_group_configs")
    .update({ ...changes, updated_at: new Date().toISOString() })
    .eq("group_id", groupId)
    .select("*")
    .single();
  if (error) throw error;
  return data as SecurityGroupConfig;
}

export async function recordSanction(
  db: DatabaseClient,
  groupId: number,
  userId: number,
  action: string,
  reason: string,
  expiresAt?: string,
): Promise<void> {
  const { error } = await db.from("security_sanctions").insert({
    group_id: groupId,
    user_id: userId,
    action,
    reason,
    expires_at: expiresAt ?? null,
  });
  if (error) throw error;
}

export async function isProtectedUser(
  db: DatabaseClient,
  groupId: number,
  userId: number,
): Promise<boolean> {
  const { data, error } = await db
    .from("security_protected_users")
    .select("user_id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function protectUser(
  db: DatabaseClient,
  groupId: number,
  userId: number,
  protectionType = "vip",
  username?: string,
): Promise<void> {
  const { error } = await db.from("security_protected_users").upsert({
    group_id: groupId,
    user_id: userId,
    reason: protectionType,
    protection_type: protectionType,
    username: username ?? null,
  }, { onConflict: "group_id,user_id" });
  if (error) throw error;
}

export async function unprotectUser(
  db: DatabaseClient,
  groupId: number,
  userId: number,
): Promise<void> {
  const { error } = await db
    .from("security_protected_users")
    .delete()
    .eq("group_id", groupId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function getWarningCount(
  db: DatabaseClient,
  groupId: number,
  userId: number,
): Promise<number> {
  const { count, error } = await db
    .from("security_events")
    .select("id", { count: "exact", head: true })
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .eq("event_type", "security_violation");
  if (error) throw error;
  return count ?? 0;
}
