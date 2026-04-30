import { Bot, GrammyError, HttpError } from "grammy";
import { env } from "../env.ts";
import { registerCommands } from "./commands.ts";
import { startActionsServer } from "../actions/server.ts";
import { closeDb } from "../db/client.ts";

async function main() {
  const bot = new Bot(env.telegramBotToken());

  registerCommands(bot);

  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`error in update ${ctx.update.update_id}:`, err.error);
    if (err.error instanceof GrammyError) console.error("grammy:", err.error.description);
    else if (err.error instanceof HttpError) console.error("http:", err.error);
  });

  const host = env.botPublicHost();
  let actionsServer: ReturnType<typeof startActionsServer> | null = null;
  if (host) {
    actionsServer = startActionsServer(env.actionsPort());
  } else {
    console.log("BOT_PUBLIC_HOST not set — /rotate will return base64 tx instead of solana-action URL");
  }

  await bot.api.setMyCommands([
    { command: "start", description: "register and show help" },
    { command: "bind_wallet", description: "link a Solana wallet pubkey" },
    { command: "status", description: "show bound wallet and LST holdings" },
    { command: "recommend", description: "show best rotation candidate" },
    { command: "rotate", description: "build the rotation transaction" },
    { command: "revoke", description: "kill-switch: revoke bot rotation authority" },
  ]);

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    await bot.stop();
    if (actionsServer) actionsServer.close();
    await closeDb();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  console.log("bot starting (long polling)...");
  await bot.start();
}

main().catch((err) => {
  console.error("bot failed:", err);
  process.exit(1);
});
