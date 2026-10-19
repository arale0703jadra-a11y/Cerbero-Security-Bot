import type { Context } from "grammy";
import type { DatabaseClient } from "../database/client.js";
import type { SecurityCommand } from "../database/types.js";
import { assertTargetIsActionable, canExecuteCommand } from "./permissions.js";
import {
  banUser,
  deleteMessage,
  kickUser,
  muteUser,
  unbanUser,
  unmuteUser,
} from "./actions.js";
import {
  addWarning,
  removeAllWarnings,
  removeWarning,
} from "../database/repositories/warnings-repository.js";
import { recordSanction } from "../database/repositories/security-config-repository.js";

export interface CommandExecutionResult {
  details?: Record<string, unknown>;
  error?: string;
}

export async function executeCommand(
  db: DatabaseClient,
  ctx: Context,
  command: SecurityCommand,
): Promise<CommandExecutionResult> {
  if (!(await canExecuteCommand(ctx, command.group_id, command.action))) {
    throw new Error(`INSUFFICIENT_PERMISSIONS: Cerbero no tiene permisos para ${command.action}.`);
  }
  const userId = command.target_user_id;
  if (userId !== null && ["MUTE_USER", "BAN_USER", "KICK_USER"].includes(command.action)) {
    await assertTargetIsActionable(ctx, command.group_id, userId);
  }
  switch (command.action) {
    case "DELETE_MESSAGE":
      if (command.target_message_id === null) throw new Error("MESSAGE_NOT_FOUND: Falta el mensaje objetivo.");
      await deleteMessage(ctx, command.group_id, command.target_message_id);
      return {};
    case "MUTE_USER":
      if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario objetivo.");
      await muteUser(ctx, command.group_id, userId, readUntilDate(command.payload));
      return {};
    case "UNMUTE_USER":
      if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario objetivo.");
      await unmuteUser(ctx, command.group_id, userId);
      return {};
    case "BAN_USER":
      if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario objetivo.");
      await banUser(ctx, command.group_id, userId);
      return {};
    case "UNBAN_USER":
      if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario objetivo.");
      await unbanUser(ctx, command.group_id, userId);
      return {};
    case "KICK_USER":
      if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario objetivo.");
      await kickUser(ctx, command.group_id, userId);
      return {};
    case "CLEAN_MESSAGES":
      return { ...(await cleanMessages(ctx, command.group_id, command.payload)) };
    case "WARN_USER":
      if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario objetivo.");
      {
        const warningCount = await addWarning(
          db,
          command.group_id,
          userId,
          typeof command.payload.reason === "string" ? command.payload.reason : "Sin motivo",
          typeof command.payload.requester_id === "number" ? command.payload.requester_id : undefined,
          typeof command.payload.requester_name === "string" ? command.payload.requester_name : undefined,
          command.id,
        );
        const limit = typeof command.payload.warn_limit === "number"
          ? command.payload.warn_limit
          : 3;
        const action = command.payload.warn_action ?? "mute";
        if (warningCount >= limit && action !== "none") {
          const untilDate = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
          if (action === "ban") {
            await banUser(ctx, command.group_id, userId);
            await recordSanction(db, command.group_id, userId, "BAN", "Límite de advertencias alcanzado");
          } else {
            await muteUser(ctx, command.group_id, userId, untilDate);
            await recordSanction(db, command.group_id, userId, "MUTE", "Límite de advertencias alcanzado", new Date(untilDate * 1000).toISOString());
          }
        }
      }
      return {};
    case "UNWARN_USER":
      if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario objetivo.");
      await removeWarning(db, command.group_id, userId);
      return {};
    case "UNWARN_ALL":
      if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario objetivo.");
      await removeAllWarnings(db, command.group_id, userId);
      return {};
  }
  throw new Error(`UNSUPPORTED_ACTION: ${command.action}`);
}

async function cleanMessages(
  ctx: Context,
  groupId: number,
  payload: Record<string, unknown>,
): Promise<CommandExecutionResult> {
  const messageIds = Array.isArray(payload.message_ids)
    ? payload.message_ids.filter(
        (messageId): messageId is number =>
          typeof messageId === "number" && Number.isInteger(messageId),
      )
    : [];
  if (messageIds.length === 0) {
    throw new Error("MESSAGE_NOT_FOUND: No hay mensajes objetivo.");
  }
  const failures: string[] = [];
  let alreadyApplied = 0;
  for (const messageId of messageIds) {
    try {
      await deleteMessage(ctx, groupId, messageId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAlreadyDeletedError(message)) {
        alreadyApplied++;
      } else {
        failures.push(message);
      }
    }
  }
  if (failures.length === messageIds.length) {
    throw new Error(`CLEAN_MESSAGES_FAILED: ${failures[0]}`);
  }
  return {
    details: {
      attempted: messageIds.length,
      deleted: messageIds.length - failures.length,
      failed: failures.length,
      alreadyApplied,
      partialErrors: failures.length > 0 ? failures : undefined,
    },
    error: failures.length > 0
      ? `CLEAN_MESSAGES_PARTIAL: ${failures.length} mensajes no pudieron eliminarse.`
      : undefined,
  };
}

function isAlreadyDeletedError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("message to delete not found") ||
    normalized.includes("message_id_invalid") ||
    normalized.includes("message can't be deleted");
}

function readUntilDate(payload: Record<string, unknown>): number | undefined {
  if (typeof payload.until_date === "number") return payload.until_date;
  if (typeof payload.duration_minutes === "number") {
    return Math.floor(Date.now() / 1000) + payload.duration_minutes * 60;
  }
  return undefined;
}
