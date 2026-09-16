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
import { getSecurityConfig } from "./database/repositories/security-config-repository.js";

async function main(): Promise<void> {
  validateConfig();
  if (!config.botToken || !config.instanceId) throw new Error("Cerbero configuration is incomplete.");
  const instanceId = config.instanceId;
  const db = createDatabaseClient();
  const bot = new Bot(config.botToken);
  const contentProvider = new NoopContentProvider();
  await bot.init();
  const botId = await registerBot(db, instanceId);
  const heartbeat = startHeartbeat(db, instanceId);

  bot.on("message", async (ctx) => {
    if (!ctx.chat) return;
    const groupConfig = await getSecurityConfig(db, ctx.chat.id);
    await detectSpam(ctx, db, groupConfig);
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

  const shutdown = async (): Promise<void> => {
    consumer.stop();
    clearInterval(heartbeat);
    await markBotOffline(db, instanceId);
    await bot.stop();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await bot.start({
    allowed_updates: ["message", "my_chat_member"],
    onStart: () => console.log(`Cerbero started as @${bot.botInfo.username}`),
  });
}

main().catch((error) => {
  console.error("Cerbero failed to start:", error);
  process.exitCode = 1;
});
