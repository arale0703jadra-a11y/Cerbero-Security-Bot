import type { DatabaseClient } from "../client.js";
import type { CommandResultState, SecurityCommand } from "../types.js";

export function getCommandResultState(
  command: Partial<SecurityCommand> | undefined,
): CommandResultState {
  const raw = command?.result_state ?? command?.status ?? "unknown";
  if (raw === "pending" || raw === "queued") return "queued";
  if (raw === "unknown") return "unknown";
  if (raw === "processing") {
    if (
      command?.lease_expires_at &&
      new Date(command.lease_expires_at).getTime() < Date.now()
    ) {
      return "unknown";
    }
    return "processing";
  }
  if (raw === "completed" || raw === "failed" || raw === "cancelled") {
    return raw;
  }
  return "unknown";
}

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

export async function markCommandExecutionStarted(
  db: DatabaseClient,
  commandId: string,
  instanceId: string,
  processingToken: string,
): Promise<boolean> {
  const now = new Date();
  const { data, error } = await db
    .from("security_commands")
    .update({ execution_started_at: now.toISOString() })
    .eq("id", commandId)
    .eq("status", "processing")
    .eq("result_state", "processing")
    .eq("processing_instance_id", instanceId)
    .eq("processing_token", processingToken)
    .is("execution_started_at", null)
    .gt("lease_expires_at", now.toISOString())
    .select("id");
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

export async function completeCommand(
  db: DatabaseClient,
  commandId: string,
  status: "completed" | "failed",
  errorMessage?: string,
  instanceId?: string,
  processingToken?: string,
): Promise<boolean> {
  let query = db
    .from("security_commands")
    .update({
      status,
      executed_at: new Date().toISOString(),
      processing_at: null,
      lease_expires_at: null,
      processing_token: null,
      processing_instance_id: null,
      last_error: errorMessage ?? null,
      result_state: status,
    })
    .eq("id", commandId)
    .eq("status", "processing")
    .eq("result_state", "processing")
    .gt("lease_expires_at", new Date().toISOString());
  if (instanceId) query = query.eq("processing_instance_id", instanceId);
  if (processingToken) query = query.eq("processing_token", processingToken);
  const { data, error } = await query.select("id");
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

export async function markCommandUnknown(
  db: DatabaseClient,
  commandId: string,
  errorMessage: string,
  instanceId: string,
  processingToken: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("security_commands")
    .update({
      result_state: "unknown",
      last_error: errorMessage,
      processing_instance_id: null,
      processing_token: null,
      processing_at: null,
      lease_expires_at: null,
    })
    .eq("id", commandId)
    .eq("status", "processing")
    .eq("result_state", "processing")
    .eq("processing_instance_id", instanceId)
    .eq("processing_token", processingToken)
    .gt("lease_expires_at", new Date().toISOString())
    .select("id");
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

export async function renewCommandLease(
  db: DatabaseClient,
  commandId: string,
  instanceId: string,
  processingToken: string,
  leaseSeconds = 90,
): Promise<boolean> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const { data, error } = await db
    .from("security_commands")
    .update({
      lease_expires_at: leaseExpiresAt,
      result_state: "processing",
    })
    .eq("id", commandId)
    .eq("status", "processing")
    .eq("processing_instance_id", instanceId)
    .eq("processing_token", processingToken)
    .eq("result_state", "processing")
    .gt("lease_expires_at", now.toISOString())
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
      result_state: "cancelled",
    })
    .eq("id", commandId)
    .in("status", ["pending", "processing"]);
  if (error) throw error;
}
