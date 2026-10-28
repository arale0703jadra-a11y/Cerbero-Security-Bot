import { Bot, Context } from "grammy";
import { config, validateConfig } from "./config.js";
import { createDatabaseClient } from "./database/client.js";
import {
  bindGroup,
  markBotOffline,
  registerBot,
} from "./database/repositories/bot-repository.js";
import { CommandConsumer } from "./security/command-consumer.js";
import { startHeartbeat } from "./services/heartbeat.js";
import { detectSpam } from "./anti-spam/detector.js";
import {
  hasMedia,
  processMedia,
  NoopContentProvider,
} from "./anti-content/detector.js";
import { getSecurityConfigResilient } from "./database/repositories/security-config-repository.js";
import { getVerifiedUserPermissions } from "./database/repositories/verified-users-repository.js";
import type { VerifiedUserPermissions } from "./database/repositories/verified-users-repository.js";
import { getVerifiedMessageRestriction } from "./security/verified-user-policy.js";
import { canExecuteCommand } from "./moderation/permissions.js";
import { deleteMessage } from "./moderation/actions.js";
import { publishEvent } from "./events/publisher.js";
import { serviceMessageCleanup } from "./service-message-cleanup.js";
import { installUpdateHealthHandling } from "./services/update-health.js";
import { createIdempotentShutdown } from "./services/shutdown.js";
import { safeErrorMessage } from "./services/resilience.js";

async function enforceVerifiedMessagePermissions(
  ctx: Context,
  db: ReturnType<typeof createDatabaseClient>,
  permissions: VerifiedUserPermissions | undefined,
): Promise<boolean> {
  if (!ctx.chat || !ctx.from || !ctx.message || !permissions) return false;
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return false;

  let member;
  try {
    member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
  } catch (error) {
    console.error(
      `[CERBERO] verified membership check failed groupId=${ctx.chat.id} userId=${ctx.from.id}: ` +
        safeErrorMessage(error),
    );
    return false;
  }
  if (member.status === "creator" || member.status === "administrator") return false;

  const hasMedia = [
    "photo",
    "video",
    "animation",
    "document",
    "sticker",
    "audio",
    "voice",
    "video_note",
  ].some((field) => field in ctx.message!);
  const restriction = getVerifiedMessageRestriction(permissions, hasMedia);
  if (!restriction) return false;

  const reason =
    restriction === "posting_disabled"
      ? "VERIFIED_PERMISSION:can_post=false"
      : "VERIFIED_PERMISSION:can_send_media=false";
  try {
    await canExecuteCommand(ctx, ctx.chat.id, "DELETE_MESSAGE");
    await deleteMessage(ctx, ctx.chat.id, ctx.message.message_id);
    await publishEvent(db, ctx.chat.id, "verified_permission_enforced", {
      messageId: ctx.message.message_id,
      reason,
      actionPerformed: "DELETE_MESSAGE",
      result: "completed",
      username: ctx.from.username,
    }, ctx.from.id);
    return true;
  } catch (error) {
    await publishEvent(db, ctx.chat.id, "verified_permission_enforcement_failed", {
      messageId: ctx.message.message_id,
      reason,
      actionRequested: "DELETE_MESSAGE",
      actionPerformed: "failed",
      actionError: safeErrorMessage(error),
      result: "failed",
      username: ctx.from.username,
    }, ctx.from.id);
    console.error(
      `[CERBERO] verified permission enforcement failed groupId=${ctx.chat.id} userId=${ctx.from.id}: ` +
        safeErrorMessage(error),
    );
    return false;
  }
}

async function main(): Promise<void> {
  validateConfig();
  if (!config.botToken || !config.instanceId) throw new Error("Cerbero configuration is incomplete.");
  const instanceId = config.instanceId;
  const db = createDatabaseClient();
  const bot = new Bot(config.botToken);
  installUpdateHealthHandling(bot);
  bot.use(serviceMessageCleanup);
  const contentProvider = new NoopContentProvider();
  await bot.init();
  const botId = await registerBot(db, instanceId);
  const heartbeat = startHeartbeat(db, instanceId);

  bot.on("message", async (ctx) => {
    if (!ctx.chat) return;
    const groupConfig = await getSecurityConfigResilient(db, ctx.chat.id);
    let verifiedPermissions: VerifiedUserPermissions | undefined;
    if (ctx.from && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
      try {
        verifiedPermissions = await getVerifiedUserPermissions(
          db,
          ctx.chat.id,
          ctx.from.id,
        );
      } catch (error) {
        console.error(
          `[CERBERO] verified permission read failed groupId=${ctx.chat.id} userId=${ctx.from.id}; security filters remain active:`,
          safeErrorMessage(error),
        );
      }
    }
    const permissionEnforced = await enforceVerifiedMessagePermissions(
      ctx,
      db,
      verifiedPermissions,
    );
    if (!permissionEnforced) {
      await detectSpam(ctx, db, groupConfig, verifiedPermissions);
    }
    if (hasMedia(ctx)) await processMedia(ctx, db, groupConfig, contentProvider);
  });
  bot.on("my_chat_member", async (ctx) => {
    if (!ctx.chat || !ctx.myChatMember) return;
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === "administrator" || status === "member") {
      await bindGroup(
        db,
        botId,
        ctx.chat.id,
        "title" in ctx.chat ? ctx.chat.title : undefined,
      );
    }
  });

  const commandContext = new Context({ update_id: 0 }, bot.api, bot.botInfo);
  const consumer = new CommandConsumer(db, commandContext, instanceId);
  consumer.start();

  const shutdown = createIdempotentShutdown([
    () => consumer.stop(),
    () => clearInterval(heartbeat),
    () => markBotOffline(db, instanceId),
    () => bot.stop(),
  ]);
  const handleShutdownSignal = (): void => {
    void shutdown().catch((error) => {
      const message = safeErrorMessage(error);
      try {
        console.error(`[CERBERO] graceful shutdown failed: ${message}`);
      } catch {
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", handleShutdownSignal);
  process.once("SIGTERM", handleShutdownSignal);

  await bot.start({
    allowed_updates: ["message", "my_chat_member"],
    onStart: () => console.log(`Cerbero started as @${bot.botInfo.username}`),
  });
}

main().catch((error) => {
  console.error("Cerbero failed to start:", safeErrorMessage(error));
  process.exitCode = 1;
});
