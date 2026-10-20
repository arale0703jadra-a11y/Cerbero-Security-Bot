import type { Context } from "grammy";
import { isFlood } from "./flood.js";
import { isRepeatedMessage } from "./repetition.js";
import type { DatabaseClient } from "../database/client.js";
import { publishEvent } from "../events/publisher.js";
import type { SecurityGroupConfig, SecurityRule, SecuritySeverity, SecurityActionName } from "../database/types.js";
import {
  getSecurityConfig,
  getWarningCount,
  isProtectedUser,
  recordSanction,
} from "../database/repositories/security-config-repository.js";
import {
  banUser,
  deleteMessage,
  kickUser,
  muteUser,
} from "../moderation/actions.js";
import { assertTargetIsActionable, canExecuteCommand } from "../moderation/permissions.js";
import { getVerifiedUserPermissions } from "../database/repositories/verified-users-repository.js";
import type { VerifiedUserPermissions } from "../database/repositories/verified-users-repository.js";
import {
  shouldSkipAutomaticDeletion,
  shouldSkipOrdinarySpamViolation,
} from "../security/verified-user-policy.js";
import { analyzeIntent } from "../services/intent-analyzer.js";

const messages = new Map<number, Array<{ text: string; at: number; userId: number }>>();

export async function detectSpam(
  ctx: Context,
  db: DatabaseClient,
  configured?: SecurityGroupConfig,
  knownVerifiedPermissions?: VerifiedUserPermissions,
): Promise<void> {
  if (!ctx.chat || !ctx.from || ctx.from.is_bot || !ctx.message) return;
  const message = ctx.message;
  const config = configured ?? (await getSecurityConfig(db, ctx.chat.id));
  if (!config.enabled) return;
  let verifiedPermissions = knownVerifiedPermissions;
  if (!verifiedPermissions) {
    try {
      verifiedPermissions = await getVerifiedUserPermissions(
        db,
        ctx.chat.id,
        ctx.from.id,
      );
    } catch (error) {
      console.error(
        `[CERBERO] verified permission read failed groupId=${ctx.chat.id} userId=${ctx.from.id}; ordinary security filters remain active:`,
        error,
      );
    }
  }

  const text = "text" in message && typeof message.text === "string" ? message.text : "";
  const caption = "caption" in message && typeof message.caption === "string"
    ? message.caption
    : "";
  const content = text || caption;
  const intent = analyzeIntent(content, verifiedPermissions !== undefined);
  if (
    config.anti_content &&
    intent.intent === "ILLEGAL_VIOLATION" &&
    (ctx.chat.type === "group" || ctx.chat.type === "supergroup")
  ) {
    let deleted = false;
    let banned = false;
    let actionError: string | undefined;
    try {
      if (await isProtectedUser(db, ctx.chat.id, ctx.from.id)) {
        throw new Error("PROTECTED_TARGET");
      }
      await assertTargetIsActionable(ctx, ctx.chat.id, ctx.from.id);
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
      console.error(
        `[CERBERO] critical intent enforcement failed groupId=${ctx.chat.id} userId=${ctx.from.id}:`,
        error,
      );
    }
    if (!actionError) {
      try {
        if (await canExecuteCommand(ctx, ctx.chat.id, "DELETE_MESSAGE")) {
          await deleteMessage(ctx, ctx.chat.id, message.message_id);
          deleted = true;
        } else {
          actionError = "BOT_CANNOT_DELETE_MESSAGE";
        }
      } catch (error) {
        actionError = error instanceof Error ? error.message : String(error);
        console.error(
          `[CERBERO] critical message deletion failed groupId=${ctx.chat.id} messageId=${message.message_id}:`,
          error,
        );
      }
      try {
        if (await canExecuteCommand(ctx, ctx.chat.id, "BAN_USER")) {
          await banUser(ctx, ctx.chat.id, ctx.from.id);
          banned = true;
          await recordSanction(
            db,
            ctx.chat.id,
            ctx.from.id,
            "ban",
            "Explicit solicitation or offer of illegal content",
          );
        } else {
          actionError ??= "BOT_CANNOT_BAN";
        }
      } catch (error) {
        actionError ??= error instanceof Error ? error.message : String(error);
        console.error(
          `[CERBERO] critical ban failed groupId=${ctx.chat.id} userId=${ctx.from.id}:`,
          error,
        );
      }
    }
    await publishEvent(db, ctx.chat.id, "security_violation", {
      messageId: message.message_id,
      groupTitle: "title" in ctx.chat ? ctx.chat.title : undefined,
      username: ctx.from.username,
      violationType: intent.intent,
      severity: "critical",
      reason: intent.reason,
      actionRequested: "permanent_ban",
      actionPerformed: banned ? "ban" : "failed",
      messageDeleted: deleted,
      actionError,
    }, ctx.from.id);
    return;
  }
  const urls = content.match(/(?:https?:\/\/|t\.me\/|www\.)\S+/gi) ?? [];
  const links = urls.some((url) => {
    if (config.allowed_link_domains.length === 0) return true;
    return !config.allowed_link_domains.some((domain) => url.toLowerCase().includes(domain.toLowerCase()));
  });
  const stickers = "sticker" in message;
  const media = ["photo", "video", "animation", "document", "voice", "video_note"]
    .some((field) => field in message);
  const now = Date.now();
  const history = messages.get(ctx.chat.id) ?? [];
  const recent = history.filter((item) => now - item.at < 10_000);
  recent.push({
    text: "sticker" in message ? "[sticker]" : ["photo", "video", "animation", "document", "voice", "video_note"].some((field) => field in message) ? "[media]" : content,
    at: now,
    userId: ctx.from.id,
  });
  messages.set(ctx.chat.id, recent.slice(-100));
  const userMessages = recent.filter((item) => item.userId === ctx.from!.id);
  const flood = isFlood(userMessages.length, 10_000);
  const repeated = isRepeatedMessage(
    userMessages.slice(0, -1).map((item) => item.text),
    content,
  );

  const violations: Array<{ type: string; severity: SecuritySeverity; reason: string; rule?: SecurityRule }> = [];
  if (config.anti_flood && flood) violations.push({ type: "flood", severity: "high", reason: "Exceso de mensajes en poco tiempo" });
  if (config.anti_spam && repeated) violations.push({ type: "spam_repeated", severity: "medium", reason: "Contenido repetido" });
  if (config.anti_links && links) violations.push({ type: "excessive_links", severity: "medium", reason: "Enlace no permitido" });
  if (config.anti_spam && stickers && userMessages.filter((item) => item.text === "[sticker]").length >= config.sticker_limit) {
    violations.push({ type: "sticker_spam", severity: "medium", reason: "Exceso de stickers" });
  }
  if (config.anti_spam && media && userMessages.filter((item) => item.text === "[media]").length >= config.media_limit) {
    violations.push({ type: "media_spam", severity: "medium", reason: "Exceso de multimedia" });
  }
  const prohibitedWord = config.prohibited_words.find((word) => content.toLowerCase().includes(word.toLowerCase()));
  if (config.anti_content && prohibitedWord) {
    violations.push({ type: "prohibited_word", severity: "critical", reason: `Palabra prohibida: ${prohibitedWord}` });
  }
  const warningCount = await getWarningCount(db, ctx.chat.id, ctx.from.id);
  if (config.reincidence_enabled && warningCount >= 1) {
    violations.push({ type: "repeat_offender", severity: warningCount >= 3 ? "critical" : "high", reason: "Usuario reincidente" });
  }
  for (const violation of violations) {
    if (
      shouldSkipOrdinarySpamViolation(
        verifiedPermissions?.bypass_antispam === true,
        violation.type,
      )
    ) {
      await publishEvent(db, ctx.chat.id, "verified_filter_bypassed", {
        messageId: message.message_id,
        violationType: violation.type,
        reason: "bypass_antispam",
        result: "skipped",
      }, ctx.from.id);
      continue;
    }
    if (
      violation.type === "excessive_links" &&
      verifiedPermissions?.bypass_promotion_filter === true
    ) {
      await publishEvent(db, ctx.chat.id, "verified_filter_bypassed", {
        messageId: message.message_id,
        violationType: violation.type,
        reason: "promotional link exemption; no shared link-intent classifier",
        result: "skipped",
      }, ctx.from.id);
      continue;
    }
    await handleViolation(
      ctx,
      db,
      config,
      violation.type,
      violation.severity,
      violation.reason,
      warningCount + 1,
      verifiedPermissions?.bypass_automatic_deletion === true,
    );
  }
}

async function handleViolation(
  ctx: Context,
  db: DatabaseClient,
  config: SecurityGroupConfig,
  type: string,
  severity: SecuritySeverity,
  reason: string,
  warningNumber: number,
  bypassAutomaticDeletion: boolean,
): Promise<void> {
  const rule = config.rules[type];
  const action: SecurityActionName = rule?.enabled === false
    ? "detect"
    : rule?.action ?? (
      config.mode === "automatic" && config.sanctions_enabled && !config.safe_mode
        ? warningNumber >= 4 ? config.warning_four_action
          : warningNumber === 3 ? config.warning_three_action
          : warningNumber === 2 ? config.warning_two_action : "warn"
        : "detect"
    );
  let performed = "logged";
  let actionError: string | undefined;

  if (action === "detect") {
    performed = "detected";
  } else if (action === "warn") {
    try {
      await ctx.reply(`⚠️ ${reason}.`, { reply_parameters: { message_id: ctx.message!.message_id } });
      performed = "warned";
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
  } else if (
    action === "delete" &&
    shouldSkipAutomaticDeletion(
      bypassAutomaticDeletion,
      severity === "critical",
    )
  ) {
    performed = "deletion_skipped_by_permission";
  } else if (config.mode === "automatic" && ctx.from) {
    try {
      if (await isProtectedUser(db, ctx.chat!.id, ctx.from.id)) {
        throw new Error("PROTECTED_TARGET: Usuario verificado.");
      }
      if (action === "delete") await canExecuteCommand(ctx, ctx.chat!.id, "DELETE_MESSAGE");
      else await canExecuteCommand(ctx, ctx.chat!.id, "MUTE_USER");
      if (action !== "delete") await assertTargetIsActionable(ctx, ctx.chat!.id, ctx.from.id);
      if (action === "delete") await deleteMessage(ctx, ctx.chat!.id, ctx.message!.message_id);
      if (action === "mute") await muteUser(ctx, ctx.chat!.id, ctx.from.id, Math.floor(Date.now() / 1000) + 30 * 60);
      if (action === "kick") await kickUser(ctx, ctx.chat!.id, ctx.from.id);
      if (action === "ban") await banUser(ctx, ctx.chat!.id, ctx.from.id);
      performed = action;
      if (action !== "delete") {
        await recordSanction(db, ctx.chat!.id, ctx.from.id, action, reason);
      }
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
  }

  await publishEvent(db, ctx.chat!.id, "security_violation", {
    messageId: ctx.message!.message_id,
    groupTitle: "title" in ctx.chat! ? ctx.chat.title : undefined,
    username: ctx.from?.username,
    violationType: type,
    severity: rule?.severity ?? severity,
    reason,
    configuredMode: config.mode,
    actionRequested: action,
    actionPerformed: performed,
    actionError,
    warningNumber,
  }, ctx.from?.id);
}
