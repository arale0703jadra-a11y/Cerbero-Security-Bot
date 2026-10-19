import type { DatabaseClient } from "../client.js";

export async function addWarning(
  db: DatabaseClient,
  groupId: number,
  userId: number,
  reason: string,
  requesterId?: number,
  requesterName?: string,
  commandId?: string,
): Promise<number> {
  if (commandId) {
    const { data: existing, error: existingError } = await db
      .from("security_warnings")
      .select("id")
      .eq("command_id", commandId)
      .limit(1)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) {
      const { error: insertError } = await db.from("security_warnings").insert({
        group_id: groupId,
        user_id: userId,
        reason,
        requester_id: requesterId ?? null,
        requester_name: requesterName ?? null,
        command_id: commandId,
      });
      if (insertError) throw insertError;
    }
  } else {
    const { error: insertError } = await db.from("security_warnings").insert({
      group_id: groupId,
      user_id: userId,
      reason,
      requester_id: requesterId ?? null,
      requester_name: requesterName ?? null,
      command_id: null,
    });
    if (insertError) throw insertError;
  }
  const { count, error } = await db
    .from("security_warnings")
    .select("id", { count: "exact", head: true })
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw error;
  return count ?? 0;
}

export async function removeWarning(
  db: DatabaseClient,
  groupId: number,
  userId: number,
): Promise<void> {
  const { data, error } = await db
    .from("security_warnings")
    .select("id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return;
  const { error: updateError } = await db
    .from("security_warnings")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", data.id);
  if (updateError) throw updateError;
}

export async function removeAllWarnings(
  db: DatabaseClient,
  groupId: number,
  userId: number,
): Promise<void> {
  const { error } = await db
    .from("security_warnings")
    .update({ revoked_at: new Date().toISOString() })
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw error;
}
