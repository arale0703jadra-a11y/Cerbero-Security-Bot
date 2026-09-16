import type { DatabaseClient } from "../client.js";

export async function registerBot(
  db: DatabaseClient,
  instanceId: string,
  version = process.env.npm_package_version ?? "1.0.0",
): Promise<string> {
  const { data, error } = await db
    .from("bots")
    .upsert(
      {
        name: "Cerbero",
        type: "security",
        status: "online",
        instance_id: instanceId,
        last_heartbeat_at: new Date().toISOString(),
        version,
      },
      { onConflict: "instance_id" },
    )
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function updateHeartbeat(
  db: DatabaseClient,
  instanceId: string,
): Promise<void> {
  const { error } = await db
    .from("bots")
    .update({ status: "online", last_heartbeat_at: new Date().toISOString() })
    .eq("instance_id", instanceId);
  if (error) throw error;
}

export async function markBotOffline(
  db: DatabaseClient,
  instanceId: string,
): Promise<void> {
  const { error } = await db
    .from("bots")
    .update({ status: "offline" })
    .eq("instance_id", instanceId);
  if (error) throw error;
}

export async function bindGroup(
  db: DatabaseClient,
  botId: string,
  groupId: number,
  title?: string,
): Promise<void> {
  const { error: groupError } = await db
    .from("groups")
    .upsert(
      { chat_id: groupId, title: title ?? null, active: true },
      { onConflict: "chat_id" },
    );
  if (groupError) throw groupError;
  const { error: bindingError } = await db
    .from("group_bot_bindings")
    .upsert(
      { group_id: groupId, bot_id: botId, permissions: {} },
      { onConflict: "group_id,bot_id" },
    );
  if (bindingError) throw bindingError;
}
