import type { Context } from "grammy";
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

export async function executeCommand(
  ctx: Context,
  command: SecurityCommand,
): Promise<void> {
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
      return;
    case "MUTE_USER":
      if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario objetivo.");
      await muteUser(ctx, command.group_id, userId, readUntilDate(command.payload));
      return;
    case "UNMUTE_USER":
      if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario objetivo.");
      await unmuteUser(ctx, command.group_id, userId);
      return;
    case "BAN_USER":
      if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario objetivo.");
      await banUser(ctx, command.group_id, userId);
      return;
    case "UNBAN_USER":
      if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario objetivo.");
      await unbanUser(ctx, command.group_id, userId);
      return;
    case "KICK_USER":
      if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario objetivo.");
      await kickUser(ctx, command.group_id, userId);
  }
}

function readUntilDate(payload: Record<string, unknown>): number | undefined {
  return typeof payload.until_date === "number" ? payload.until_date : undefined;
}
