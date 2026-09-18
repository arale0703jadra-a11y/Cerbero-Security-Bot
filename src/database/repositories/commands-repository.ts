import type { DatabaseClient } from "../client.js";
import type { SecurityCommand } from "../types.js";

export async function claimNextCommand(
  db: DatabaseClient,
  instanceId: string,
): Promise<SecurityCommand | undefined> {
  const { data, error } = await db.rpc("claim_security_command", {
    p_instance_id: instanceId,
  });
  if (error) throw error;
  const command = Array.isArray(data) ? data[0] : data;
  return (command as SecurityCommand | undefined) ?? undefined;
}

export async function completeCommand(
  db: DatabaseClient,
  commandId: string,
  status: "completed" | "failed",
  errorMessage?: string,
  instanceId?: string,
  processingToken?: string,
): Promise<void> {
  let query = db
    .from("security_commands")
    .update({
      status,
      executed_at: new Date().toISOString(),
      processing_at: null,
      lease_expires_at: null,
      processing_token: null,
      last_error: errorMessage ?? null,
    })
    .eq("id", commandId)
    .eq("status", "processing");
  if (instanceId) query = query.eq("processing_instance_id", instanceId);
  if (processingToken) query = query.eq("processing_token", processingToken);
  const { error } = await query;
  if (error) throw error;
}

export async function renewCommandLease(
  db: DatabaseClient,
  commandId: string,
  instanceId: string,
  processingToken: string,
  leaseSeconds = 90,
): Promise<boolean> {
  const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const { data, error } = await db
    .from("security_commands")
    .update({ lease_expires_at: leaseExpiresAt })
    .eq("id", commandId)
    .eq("status", "processing")
    .eq("processing_instance_id", instanceId)
    .eq("processing_token", processingToken)
    .select("id");
  if (error) throw error;
  return Array.isArray(data) ? data.length > 0 : Boolean(data);
}

export async function cancelCommand(
  db: DatabaseClient,
  commandId: string,
): Promise<void> {
  const { error } = await db
    .from("security_commands")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      processing_instance_id: null,
      processing_at: null,
      processing_token: null,
      lease_expires_at: null,
    })
    .eq("id", commandId)
    .in("status", ["pending", "processing"]);
  if (error) throw error;
}
