import type { Context } from "grammy";
import type { DatabaseClient } from "../database/client.js";
import type { SecurityGroupConfig, SecurityActionName } from "../database/types.js";
import { publishEvent } from "../events/publisher.js";
import { deleteMessage, muteUser, kickUser, banUser } from "../moderation/actions.js";
import { assertTargetIsActionable, canExecuteCommand } from "../moderation/permissions.js";
import { getVerifiedUserPermissions, type VerifiedUserPermissions } from "../database/repositories/verified-users-repository.js";
import {
  getWarningCount,
  isProtectedUser,
  recordSanction,
} from "../database/repositories/security-config-repository.js";
import { shouldSkipAutomaticDeletion, shouldSkipIllegalFilter } from "../security/verified-user-policy.js";
import { safeErrorMessage } from "../services/resilience.js";

export interface ContentDetection {
  detected: boolean;
  category?: "prohibited_image" | "nsfw" | "dangerous_file";
  reason?: string;
  critical?: boolean;
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
  let verifiedPermissions: VerifiedUserPermissions | undefined;
  try {
    verifiedPermissions = await getVerifiedUserPermissions(db, ctx.chat.id, ctx.from.id);
  } catch (error) {
    // Mínimo privilegio: si no podemos leer los permisos, no concedemos
    // ninguna excepción y dejamos que los filtros de contenido sigan activos.
    verifiedPermissions = undefined;
    console.error(
      `[CERBERO] verified permission read failed groupId=${ctx.chat.id} userId=${ctx.from.id}; content filters remain active:`,
      safeErrorMessage(error),
    );
  }
  if (
    shouldSkipIllegalFilter(
      verifiedPermissions?.bypass_illegal_filter === true,
      detection.critical === true,
    )
  ) {
    return;
  }
  const rule = config.rules[detection.category ?? "media"];
  const action: SecurityActionName = rule?.enabled === false
    ? "detect"
    : rule?.action ?? (config.mode === "automatic" && config.sanctions_enabled && !config.safe_mode
      ? warningNumber >= 4 ? config.warning_four_action
        : warningNumber === 3 ? config.warning_three_action
        : warningNumber === 2 ? config.warning_two_action : "warn"
      : "detect");
  const effectiveAction =
    action === "delete" &&
    shouldSkipAutomaticDeletion(
      verifiedPermissions?.bypass_automatic_deletion === true,
      detection.critical === true,
    )
      ? "detect"
      : action;
  let performed = "logged";
  let actionError: string | undefined;
  try {
    if (effectiveAction === "detect") {
      performed = "detected";
    } else if (effectiveAction === "warn") {
      await ctx.reply(`⚠️ Contenido detectado: ${detection.reason ?? "revisión necesaria"}.`);
      performed = "warned";
    } else {
      if (await isProtectedUser(db, ctx.chat.id, ctx.from.id)) {
        throw new Error("PROTECTED_TARGET: Usuario verificado.");
      }
      await canExecuteCommand(ctx, ctx.chat.id, effectiveAction === "delete" ? "DELETE_MESSAGE" : "MUTE_USER");
      if (effectiveAction !== "delete") await assertTargetIsActionable(ctx, ctx.chat.id, ctx.from.id);
      if (effectiveAction === "delete") await deleteMessage(ctx, ctx.chat.id, ctx.message.message_id);
      if (effectiveAction === "mute") await muteUser(ctx, ctx.chat.id, ctx.from.id, Math.floor(Date.now() / 1000) + 30 * 60);
      if (effectiveAction === "kick") await kickUser(ctx, ctx.chat.id, ctx.from.id);
      if (effectiveAction === "ban") await banUser(ctx, ctx.chat.id, ctx.from.id);
      performed = effectiveAction;
      if (effectiveAction !== "delete") await recordSanction(db, ctx.chat.id, ctx.from.id, effectiveAction, detection.reason ?? "Contenido prohibido");
    }
  } catch (error) {
    actionError = safeErrorMessage(error);
  }
  await publishEvent(db, ctx.chat.id, "prohibited_content_detected", {
    messageId: ctx.message.message_id,
    groupTitle: "title" in ctx.chat ? ctx.chat.title : undefined,
    username: ctx.from.username,
    category: detection.category,
    severity: rule?.severity ?? "high",
    reason: detection.reason,
    actionRequested: effectiveAction,
    actionPerformed: performed,
    actionError,
    warningNumber,
  }, ctx.from.id);
}
