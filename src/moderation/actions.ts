import type { Context } from "grammy";

export async function deleteMessage(
  ctx: Context,
  groupId: number,
  messageId: number,
): Promise<void> {
  await ctx.api.deleteMessage(groupId, messageId);
}

export async function muteUser(
  ctx: Context,
  groupId: number,
  userId: number,
  untilDate?: number,
): Promise<void> {
  await ctx.api.restrictChatMember(groupId, userId, {
    can_send_messages: false,
  }, untilDate === undefined ? undefined : { until_date: untilDate });
}

export async function unmuteUser(
  ctx: Context,
  groupId: number,
  userId: number,
): Promise<void> {
  await ctx.api.restrictChatMember(groupId, userId, {
    can_send_messages: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_other_messages: true,
  });
}

export async function banUser(
  ctx: Context,
  groupId: number,
  userId: number,
): Promise<void> {
  await ctx.api.banChatMember(groupId, userId);
}

export async function unbanUser(
  ctx: Context,
  groupId: number,
  userId: number,
): Promise<void> {
  await ctx.api.unbanChatMember(groupId, userId, { only_if_banned: true });
}

export async function kickUser(
  ctx: Context,
  groupId: number,
  userId: number,
): Promise<void> {
  await ctx.api.banChatMember(groupId, userId);
  await ctx.api.unbanChatMember(groupId, userId, { only_if_banned: true });
}
