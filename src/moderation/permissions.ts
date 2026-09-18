import type { Context } from "grammy";

export async function canExecuteCommand(
  ctx: Context,
  groupId: number,
  action: string,
): Promise<boolean> {
  let member;
  try {
    member = await ctx.api.getChatMember(groupId, ctx.me.id);
  } catch {
    throw new Error("BOT_NOT_ADMIN: Cerbero no es administrador del grupo.");
  }
  if (member.status !== "administrator" && member.status !== "creator") {
    throw new Error("BOT_NOT_ADMIN: Cerbero no es administrador del grupo.");
  }

  if (member.status === "creator") return true;
  if (["DELETE_MESSAGE", "CLEAN_MESSAGES"].includes(action)) {
    return member.can_delete_messages === true;
  }
  if (["MUTE_USER", "UNMUTE_USER", "BAN_USER", "UNBAN_USER", "KICK_USER"].includes(action)) {
    return member.can_restrict_members === true;
  }
  if (action === "WARN_USER") return member.can_restrict_members === true;
  if (["UNWARN_USER", "UNWARN_ALL"].includes(action)) return true;
  return false;
}

export async function assertTargetIsActionable(
  ctx: Context,
  groupId: number,
  userId: number,
): Promise<void> {
  const target = await ctx.api.getChatMember(groupId, userId);
  if (target.status === "creator" || target.status === "administrator") {
    throw new Error("PROTECTED_TARGET: El propietario o administrador está protegido.");
  }
}
