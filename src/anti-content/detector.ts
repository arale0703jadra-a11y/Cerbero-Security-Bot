import type { Context } from "grammy";
import type { DatabaseClient } from "../database/client.js";
import type { SecurityGroupConfig, SecurityActionName } from "../database/types.js";
import { publishEvent } from "../events/publisher.js";
import { deleteMessage, muteUser, kickUser, banUser } from "../moderation/actions.js";
import { assertTargetIsActionable, canExecuteCommand } from "../moderation/permissions.js";
import {
  getWarningCount,
  isProtectedUser,
  recordSanction,
} from "../database/repositories/security-config-repository.js";

export interface ContentDetection {
  detected: boolean;
  category?: "prohibited_image" | "nsfw" | "dangerous_file";
  reason?: string;
}

export interface ContentProvider {
  detect(ctx: Context): Promise<ContentDetection>;
}

export class NoopContentProvider implements ContentProvider {
  async detect(): Promise<ContentDetection> {
    return { detected: false };
  }
}

export function hasMedia(ctx: Context): boolean {
  const message = ctx.message;
  if (!message) return false;
  return [
    "photo",
    "video",
    "animation",
    "document",
    "sticker",
    "voice",
    "video_note",
  ].some((field) => field in message);
}

export async function detectContent(
  ctx: Context,
  provider: ContentProvider,
): Promise<ContentDetection> {
  return provider.detect(ctx);
}

export async function processMedia(
  ctx: Context,
  db: DatabaseClient,
  config: SecurityGroupConfig,
  provider: ContentProvider,
): Promise<void> {
  if (!ctx.chat || !ctx.from || ctx.from.is_bot || !ctx.message || !config.enabled || !config.media_protection || !config.anti_content) return;
  const detection = await detectContent(ctx, provider);
  if (!detection.detected) {
    await publishEvent(db, ctx.chat.id, "media_observed", {
      messageId: ctx.message.message_id,
      provider: provider.constructor.name,
    }, ctx.from.id);
    return;
  }
  const warningNumber = (await getWarningCount(db, ctx.chat.id, ctx.from.id)) + 1;
  const rule = config.rules[detection.category ?? "media"];
  const action: SecurityActionName = rule?.enabled === false
    ? "detect"
    : rule?.action ?? (config.mode === "automatic" && config.sanctions_enabled && !config.safe_mode
      ? warningNumber >= 4 ? config.warning_four_action
        : warningNumber === 3 ? config.warning_three_action
        : warningNumber === 2 ? config.warning_two_action : "warn"
      : "detect");
  let performed = "logged";
  let actionError: string | undefined;
  try {
    if (action === "detect") {
      performed = "detected";
    } else if (action === "warn") {
      await ctx.reply(`⚠️ Contenido detectado: ${detection.reason ?? "revisión necesaria"}.`);
      performed = "warned";
    } else {
      if (await isProtectedUser(db, ctx.chat.id, ctx.from.id)) {
        throw new Error("PROTECTED_TARGET: Usuario verificado.");
      }
      await canExecuteCommand(ctx, ctx.chat.id, action === "delete" ? "DELETE_MESSAGE" : "MUTE_USER");
      if (action !== "delete") await assertTargetIsActionable(ctx, ctx.chat.id, ctx.from.id);
      if (action === "delete") await deleteMessage(ctx, ctx.chat.id, ctx.message.message_id);
      if (action === "mute") await muteUser(ctx, ctx.chat.id, ctx.from.id, Math.floor(Date.now() / 1000) + 30 * 60);
      if (action === "kick") await kickUser(ctx, ctx.chat.id, ctx.from.id);
      if (action === "ban") await banUser(ctx, ctx.chat.id, ctx.from.id);
      performed = action;
      if (action !== "delete") await recordSanction(db, ctx.chat.id, ctx.from.id, action, detection.reason ?? "Contenido prohibido");
    }
  } catch (error) {
    actionError = error instanceof Error ? error.message : String(error);
  }
  await publishEvent(db, ctx.chat.id, "prohibited_content_detected", {
    messageId: ctx.message.message_id,
    groupTitle: "title" in ctx.chat ? ctx.chat.title : undefined,
    username: ctx.from.username,
    category: detection.category,
    severity: rule?.severity ?? "high",
    reason: detection.reason,
    actionRequested: action,
    actionPerformed: performed,
    actionError,
    warningNumber,
  }, ctx.from.id);
}
