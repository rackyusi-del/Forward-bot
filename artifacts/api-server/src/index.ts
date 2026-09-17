import app from "./app";
import { logger } from "./lib/logger";
import { startTelegramBot } from "./telegram/bot";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void runTelegramBotSupervisor();
});

let shuttingDown = false;
process.once("SIGTERM", () => {
  shuttingDown = true;
});
process.once("SIGINT", () => {
  shuttingDown = true;
});

async function runTelegramBotSupervisor(): Promise<void> {
  let retryDelayMs = 5_000;

  while (!shuttingDown) {
    try {
      await startTelegramBot();
      if (shuttingDown) break;
      logger.warn("Telegram bot listener exited; restarting it");
    } catch (error) {
      if (shuttingDown) break;
      logger.error({ err: error }, "Telegram bot listener failed; restarting it");
    }

    if (shuttingDown) break;
    await pause(retryDelayMs);
    retryDelayMs = Math.min(60_000, retryDelayMs * 2);
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
