import { logger } from "../lib/logger";
import { TelegramApi, TelegramApiError } from "./api";
import { contentLabel } from "./filter";
import {
  type ContentType,
  StateStore,
  type QueueItem,
  type UserState,
} from "./state";
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "./types";
import {
  TelegramUserClient,
  UncertainTransferError,
  type Heartbeat,
} from "./user-client";
import { parseTelegramSourceUrl } from "./url";
import {
  languageLabel,
  languageOptions,
  type LanguageCode,
  translate,
} from "./i18n";

const contentButtons: Array<{ text: string; value: ContentType }> = [
  { text: "Files", value: "files" },
  { text: "Photos", value: "photos" },
  { text: "Videos", value: "videos" },
  { text: "Voice", value: "voice" },
  { text: "Messages", value: "messages" },
  { text: "Other Media", value: "other" },
];

const slowerTransferSpeeds = Array.from({ length: 10 }, (_, index) => (index + 1) / 10);
const fasterTransferSpeeds = Array.from({ length: 10 }, (_, index) => index + 1);
const transferSpeeds = [
  ...slowerTransferSpeeds.map((speed) => ({ speed, icon: "🐢" })),
  ...fasterTransferSpeeds.map((speed) => ({ speed, icon: "🐇" })),
];
// Keep account-level concurrency conservative. Telegram may impose a
// multi-minute FloodWait when several file uploads run in parallel.
const MAX_TRANSFER_WORKERS = boundedEnvNumber("MAX_TRANSFER_WORKERS", 2, 1, 3);
// Keep a small reservation window. Items are committed one by one below so a
// slow Telegram request cannot make a large group of items look uncertain.
const TRANSFER_BATCH_SIZE = boundedEnvNumber("TRANSFER_BATCH_SIZE", 10, 1, 50);
const LIVE_POLL_INTERVAL_MS = boundedEnvNumber(
  "LIVE_POLL_INTERVAL_MS",
  15_000,
  5_000,
  120_000,
);
const TRANSFER_STALL_TIMEOUT_MS = boundedEnvNumber(
  "TRANSFER_STALL_TIMEOUT_MS",
  60 * 60_000,
  60_000,
  24 * 60 * 60_000,
);
const TRANSFER_STOP_WAIT_MS = 10_000;

interface PendingInput {
  chatId: number;
  resolve: (value: string) => void;
}


interface TransferRun {
  cancelled: boolean;
  done: Promise<void>;
  resolveDone: () => void;
  lastActivityAt: number;
  operationInFlight: boolean;
}

interface LiveWatcher {
  cancelled: boolean;
  done: Promise<void>;
  resolveDone: () => void;
  notifyChatId: number;
  notifyThreadId?: number;
}

export async function startTelegramBot(): Promise<void> {
  const token = process.env.BOT_TOKEN?.trim();
  if (!token) {
    logger.warn("BOT_TOKEN is not set; Telegram listener is disabled");
    return;
  }

  const bot = new ForwardingBot(
    new TelegramApi(token),
    new StateStore(),
    new TelegramUserClient(),
  );
  await bot.run();
}

class ForwardingBot {
  private stopping = false;
  private readonly pendingInputs = new Map<number, PendingInput>();
  private readonly transferRuns = new Map<number, TransferRun>();
  private readonly liveWatchers = new Map<number, LiveWatcher>();
  private readonly scheduleTimers = new Map<number, NodeJS.Timeout>();
  private readonly lastProgressUpdateAt = new Map<number, number>();
  private updateChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: TelegramApi,
    private readonly state: StateStore,
    private readonly userClient: TelegramUserClient,
  ) {}

  async run(): Promise<void> {
    await this.state.load();
    const bot = await this.api.getMe();
    await this.api
      .setMyCommands([
        { command: "start", description: "Show help" },
        { command: "login", description: "Connect Telegram account" },
        { command: "transferspeed", description: "Choose transfer speed" },
        { command: "queue", description: "Show current queue" },
        { command: "status", description: "Show transfer status" },
        { command: "history", description: "Show transfer history" },
        { command: "stats", description: "Show transfer statistics" },
        { command: "logs", description: "Show recent errors" },
        { command: "retry", description: "Retry failed items" },
         { command: "retry_uncertain", description: "Retry verified uncertain items" },
        { command: "skip", description: "Skip next pending item" },
        { command: "stop", description: "Pause transfer" },
         { command: "on", description: "Resume transfer" },
        { command: "resume", description: "Resume transfer" },
        { command: "cancel", description: "Cancel current queue" },
        { command: "filter", description: "Filter source items" },
        { command: "maxsize", description: "Set maximum file size" },
        { command: "schedule", description: "Schedule a transfer" },
        { command: "notify", description: "Toggle completion notifications" },
        { command: "destination", description: "Show current destination" },
        { command: "language", description: "Choose language" },
        { command: "live", description: "Toggle live source monitoring" },
        { command: "settings", description: "Show settings" },
        { command: "privacy", description: "Show privacy information" },
        { command: "ping", description: "Check bot status" },
      ])
      .catch((error) => logger.warn({ err: error }, "Could not register Telegram commands"));
    await this.api.deleteWebhook();
    await this.restoreSchedules();
    await this.restoreLiveWatchersAndQueues();
    logger.info(
      { username: bot.username ?? bot.first_name },
      "Telegram polling started",
    );

    const stop = () => {
      this.stopping = true;
      void this.state.flush();
      void this.userClient.disconnectAll();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);

    while (!this.stopping) {
      try {
        const updates = await this.api.getUpdates(this.state.offset + 1);
        for (const update of updates) {
          this.updateChain = this.updateChain
            .then(() => this.handleUpdate(update))
            .catch((error) => {
              logger.warn({ err: error, updateId: update.update_id }, "Telegram update failed");
            });
          await this.state.setOffset(update.update_id);
        }
      } catch (error) {
        if (error instanceof TelegramApiError && error.errorCode === 409) {
          logger.error("Telegram polling conflict: another bot instance is using BOT_TOKEN");
        } else {
          logger.warn({ err: error }, "Telegram polling error; retrying");
        }
        await pause(3_000);
      }
    }
    logger.info("Telegram polling stopped");
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

    const message = update.message ?? update.channel_post;
    if (!message) return;
    const userId = message.from?.id ?? this.channelActorId();
    if (userId === undefined) return;

    if (this.consumePendingInput(message)) return;
    if (await this.handleControlMessage(message, userId)) return;
  }

  private async handleControlMessage(
    message: TelegramMessage,
    actorId?: number,
  ): Promise<boolean> {
    const userId = actorId ?? message.from?.id;
    if (userId === undefined) return false;
    const text = message.text?.trim() ?? "";
    const normalized = text.toLowerCase();
    const isPrivate = message.chat.type === "private";
    const [rawCommand, ...args] = normalized.split(/\s+/);
    const command = rawCommand.split("@", 1)[0];
    const user = this.state.getUser(userId);

    if (command === "/language") {
      if (!isPrivate) {
        await this.api.sendMessage(message.chat.id, "Use /language in the bot's private chat.");
        return true;
      }
      await this.api.sendMessage(message.chat.id, translate(user.language, "languageChoose"), {
        replyMarkup: this.languageKeyboard(user.language),
      });
      return true;
    }

    if (command === "/settings") {
      await this.api.sendMessage(message.chat.id, translate(user.language, "settings", {
        language: languageLabel(user.language),
        speed: formatSpeed(user.transferSpeed),
        live: user.liveMode ? "on" : "off",
        notify: user.notifyOnComplete ? "on" : "off",
        maxSize: user.maxFileSizeMb ? `${user.maxFileSizeMb} MB` : "unlimited",
        filter: user.filterText ?? "none",
      }));
      return true;
    }

    if (command === "/live") {
      const value = args[0];
      if (value !== "on" && value !== "off") {
        await this.api.sendMessage(message.chat.id, "Usage: /live on or /live off");
      } else {
        const enabled = value === "on";
        await this.state.setLiveMode(userId, enabled);
        if (enabled) {
          this.startLiveWatcher(userId, message.chat.id, message.message_thread_id);
        } else {
          await this.stopLiveWatcher(userId);
        }
        await this.api.sendMessage(
          message.chat.id,
          value === "on"
            ? "Live source monitoring is on. New matching files will be queued automatically."
            : "Live source monitoring is off. The current queue will finish normally.",
        );
      }
      return true;
    }

    if (command === "/queue") {
      await this.api.sendMessage(message.chat.id, this.queueText(user));
      return true;
    }

    if (command === "/retry" || command === "/retryall") {
      await this.stopExistingTransfer(userId);
      await this.state.retryFailed(userId);
      await this.api.sendMessage(message.chat.id, translate(user.language, "transferResumed"));
      void this.startTransfer(userId, message.chat.id, message.message_thread_id);
      return true;
    }

    if (command === "/retry_uncertain" || command === "/retryuncertain") {
      await this.stopExistingTransfer(userId);
      await this.state.retryUncertain(userId);
      await this.api.sendMessage(
        message.chat.id,
        "Uncertain items were released. Use this only after checking that Telegram did not receive them.",
      );
      void this.startTransfer(userId, message.chat.id, message.message_thread_id);
      return true;
    }

    if (command === "/skip") {
      const skipped = await this.state.skipNext(userId);
      await this.api.sendMessage(
        message.chat.id,
        skipped
          ? translate(user.language, "skipDone", { name: skipped.name })
          : translate(user.language, "queueEmpty"),
      );
      return true;
    }

    if (command === "/logout") {
      await this.stopExistingTransfer(userId);
      await this.state.setRunning(userId, false);
      await this.userClient.logout(userId);
      await this.state.setAuthorized(userId, false);
      await this.state.reset(userId);
      await this.api.sendMessage(message.chat.id, translate(user.language, "logoutDone"));
      return true;
    }

    if (command === "/destination") {
      await this.api.sendMessage(message.chat.id, translate(user.language, "destination", {
        destination: user.target?.title ?? (user.target ? String(user.target.chatId) : "not set"),
      }));
      return true;
    }

    if (command === "/pause") {
      await this.stopExistingTransfer(userId);
      await this.state.setRunning(userId, false);
      await this.api.sendMessage(message.chat.id, translate(user.language, "transferPaused"));
      return true;
    }

    if (command === "/clear") {
      await this.stopExistingTransfer(userId);
      await this.state.cancelQueue(userId);
      await this.api.sendMessage(message.chat.id, translate(user.language, "queueCleared"));
      return true;
    }

    if (command === "/speed") {
      await this.api.sendMessage(
        message.chat.id,
        translate(user.language, "transferSpeed", { speed: formatSpeed(user.transferSpeed) }),
        { replyMarkup: this.transferSpeedKeyboard(user.transferSpeed) },
      );
      return true;
    }

    if (command === "/ping") {
      await this.api.sendMessage(message.chat.id, translate(user.language, "ping"));
      return true;
    }

    if (command === "/privacy") {
      await this.api.sendMessage(message.chat.id, translate(user.language, "privacy"));
      return true;
    }

    if (command === "/history") {
      await this.api.sendMessage(message.chat.id, this.historyText(user));
      return true;
    }

    if (command === "/stats") {
      const sent = user.history.reduce((total, item) => total + item.sent, 0);
      const failed = user.history.reduce((total, item) => total + item.failed, 0);
      await this.api.sendMessage(message.chat.id, translate(user.language, "stats", {
        transfers: user.history.length,
        sent,
        failed,
        duplicates: user.duplicateCount,
      }));
      return true;
    }

    if (command === "/logs") {
      await this.api.sendMessage(message.chat.id, translate(user.language, "logs", {
        items: user.lastError ?? "No recent errors",
      }));
      return true;
    }

    if (command === "/duplicates") {
      await this.api.sendMessage(message.chat.id, translate(user.language, "duplicates", {
        count: user.duplicateCount,
      }));
      return true;
    }

    if (command === "/filter") {
      const value = args.join(" ").trim();
      if (!value) {
        await this.api.sendMessage(message.chat.id, translate(user.language, "filterUsage"));
      } else if (value === "off" || value === "clear") {
        await this.state.setFilter(userId, undefined);
        await this.api.sendMessage(message.chat.id, translate(user.language, "filterCleared"));
      } else {
        await this.state.setFilter(userId, value);
        await this.api.sendMessage(message.chat.id, translate(user.language, "filterSet", { filter: value }));
      }
      return true;
    }

    if (command === "/maxsize") {
      const value = args[0];
      if (!value) {
        await this.api.sendMessage(message.chat.id, translate(user.language, "maxSizeUsage"));
      } else if (value === "off" || value === "clear") {
        await this.state.setMaxFileSize(userId, undefined);
        await this.api.sendMessage(message.chat.id, translate(user.language, "maxSizeCleared"));
      } else {
        const size = Number(value);
        if (!Number.isFinite(size) || size <= 0) {
          await this.api.sendMessage(message.chat.id, translate(user.language, "maxSizeUsage"));
        } else {
          await this.state.setMaxFileSize(userId, size);
          await this.api.sendMessage(message.chat.id, translate(user.language, "maxSizeSet", { size: Math.round(size) }));
        }
      }
      return true;
    }

    if (command === "/notify") {
      const value = args[0];
      if (value !== "on" && value !== "off") {
        await this.api.sendMessage(message.chat.id, "Usage: /notify on or /notify off");
      } else {
        await this.state.setNotifyOnComplete(userId, value === "on");
        await this.api.sendMessage(message.chat.id, translate(user.language, "notifySet", {
          state: value === "on" ? "on" : "off",
        }));
      }
      return true;
    }

    if (command === "/schedule") {
      const value = args[0];
      if (!value) {
        await this.api.sendMessage(message.chat.id, translate(user.language, "scheduleUsage"));
      } else if (value === "off" || value === "clear") {
        await this.clearSchedule(userId);
        await this.api.sendMessage(message.chat.id, translate(user.language, "scheduleCleared"));
      } else {
        const minutes = Number(value);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10080) {
          await this.api.sendMessage(message.chat.id, translate(user.language, "scheduleUsage"));
        } else {
          await this.state.setScheduledAt(userId, new Date(Date.now() + minutes * 60_000).toISOString());
          await this.api.sendMessage(message.chat.id, translate(user.language, "scheduleSet", { minutes: Math.round(minutes) }));
        }
      }
      return true;
    }

    if (normalized === "/myid" && isPrivate) {
      await this.api.sendMessage(message.chat.id, `Your Telegram ID is: ${userId}`);
      return true;
    }

    if (normalized === "/start" || normalized === "/help") {
      await this.api.sendMessage(message.chat.id, this.helpText(user.language));
      return true;
    }

    if (normalized === "/login") {
      if (!isPrivate) {
        await this.api.sendMessage(message.chat.id, "Send /login in this bot's private chat.", {
          threadId: message.message_thread_id,
        });
        return true;
      }
      void this.startPersonalLogin(userId, message.chat.id);
      return true;
    }

    if (normalized === "/status") {
      await this.api.sendMessage(message.chat.id, this.statusText(this.state.getUser(userId)));
      return true;
    }

    if (normalized === "/transferspeed") {
      if (!isPrivate) {
        await this.api.sendMessage(message.chat.id, "Use /transferspeed in the bot's private chat.", {
          threadId: message.message_thread_id,
        });
        return true;
      }
      await this.api.sendMessage(
        message.chat.id,
        `${translate(user.language, "transferSpeed", { speed: formatSpeed(user.transferSpeed) })}\n🐢 Slow options: 0.1x–1x\n🐇 Fast options: 1x–10x`,
        { replyMarkup: this.transferSpeedKeyboard(this.state.getUser(userId).transferSpeed) },
      );
      return true;
    }

    if (normalized === "/stop") {
      await this.stopExistingTransfer(userId);
      await this.api.sendMessage(
        message.chat.id,
        "Transfer stopped. The active item was kept in the queue. Send /on to continue from here.",
        { threadId: message.message_thread_id },
      );
      return true;
    }

    if (normalized === "/resume" || normalized === "/on") {
      if (!isPrivate) {
        await this.api.sendMessage(message.chat.id, "Use /on in the bot's private chat.");
        return true;
      }
      await this.stopExistingTransfer(userId);
      await this.state.retryFailed(userId);
      void this.startTransfer(userId, message.chat.id);
      await this.api.sendMessage(message.chat.id, "Transfer is on. Continuing from the saved queue.");
      return true;
    }

    if (normalized === "/cancel") {
      await this.stopExistingTransfer(userId);
      await this.state.cancelQueue(userId);
      await this.api.sendMessage(message.chat.id, translate(user.language, "transferCancelled"));
      return true;
    }

    if (normalized === "/reset") {
      await this.stopExistingTransfer(userId);
      await this.state.reset(userId);
      await this.api.sendMessage(message.chat.id, "Saved source, selection, destination and queue were reset.");
      return true;
    }

    if (!isPrivate && normalized === ".sendhere") {
      await this.handleSendHere(message, userId);
      return true;
    }

    const source = parseTelegramSourceUrl(text);
    if (source) {
      if (!isPrivate) {
        await this.api.sendMessage(message.chat.id, "Send the source URL in the bot's private chat.", {
          threadId: message.message_thread_id,
        });
        return true;
      }
      if (!user.authorized) {
        await this.api.sendMessage(message.chat.id, "Send /login first. Source history is read through your authorized Telegram account.");
        return true;
      }
      await this.state.setSource(userId, source);
      await this.api.sendMessage(
        message.chat.id,
        `Source saved: ${source.label}\n\nChoose a content type. The bot will scan old and currently available history through your authorized account.`,
        { replyMarkup: this.contentKeyboard() },
      );
      return true;
    }

    return false;
  }

  private async handleSendHere(message: TelegramMessage, userId: number): Promise<void> {
    const user = this.state.getUser(userId);
    if (!user.authorized) {
      await this.api.sendMessage(message.chat.id, "Send /login first in the bot's private chat.", {
        threadId: message.message_thread_id,
      });
      return;
    }
    if (!user.queue.length) {
      await this.api.sendMessage(message.chat.id, "Select and queue items in the bot's private chat before using .sendhere.", {
        threadId: message.message_thread_id,
      });
      return;
    }

    await this.state.setTarget(userId, {
      chatId: message.chat.id,
      title: message.chat.title,
      threadId: message.message_thread_id,
    });
    const scheduledAt = user.scheduledAt ? Date.parse(user.scheduledAt) : NaN;
    if (Number.isFinite(scheduledAt) && scheduledAt > Date.now()) {
      await this.scheduleTransfer(userId, message.chat.id, message.message_thread_id, scheduledAt);
      return;
    }
    await this.state.setScheduledAt(userId, undefined);
    await this.startTransfer(userId, message.chat.id, message.message_thread_id);
  }

  private async scheduleTransfer(
    userId: number,
    chatId: number,
    threadId: number | undefined,
    scheduledAt: number,
  ): Promise<void> {
    const existing = this.scheduleTimers.get(userId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, scheduledAt - Date.now());
    await this.api.sendMessage(
      chatId,
      `Transfer scheduled for ${new Date(scheduledAt).toLocaleString()}.`,
      { threadId },
    );
    const timer = setTimeout(() => {
      this.scheduleTimers.delete(userId);
      void this.state.setScheduledAt(userId, undefined);
      void this.startTransfer(userId, chatId, threadId);
    }, delay);
    this.scheduleTimers.set(userId, timer);
  }

  private async restoreSchedules(): Promise<void> {
    for (const user of this.state.listUsers()) {
      if (!user.scheduledAt || !user.target || !user.queue.length) continue;
      const scheduledAt = Date.parse(user.scheduledAt);
      if (!Number.isFinite(scheduledAt)) {
        await this.state.setScheduledAt(user.userId, undefined);
        continue;
      }
      if (scheduledAt <= Date.now()) {
        await this.state.setScheduledAt(user.userId, undefined);
        void this.startTransfer(user.userId, user.target.chatId, user.target.threadId);
        continue;
      }
      await this.scheduleTransfer(
        user.userId,
        user.target.chatId,
        user.target.threadId,
        scheduledAt,
      );
    }
  }

  private async clearSchedule(userId: number): Promise<void> {
    const timer = this.scheduleTimers.get(userId);
    if (timer) clearTimeout(timer);
    this.scheduleTimers.delete(userId);
    await this.state.setScheduledAt(userId, undefined);
  }

  private consumePendingInput(message: TelegramMessage): boolean {
    const userId = message.from?.id;
    if (
      userId === undefined ||
      message.chat.type !== "private" ||
      !message.text?.trim()
    ) {
      return false;
    }
    const pending = this.pendingInputs.get(userId);
    if (!pending || pending.chatId !== message.chat.id) return false;

    this.pendingInputs.delete(userId);
    void this.api.deleteMessage(message.chat.id, message.message_id).catch(() => undefined);
    pending.resolve(message.text.trim());
    return true;
  }

  private waitForInput(userId: number, chatId: number, question: string): Promise<string> {
    if (this.pendingInputs.has(userId)) {
      return Promise.reject(new Error("A Telegram login prompt is already waiting for input"));
    }
    void this.api.sendMessage(chatId, question);
    return new Promise((resolve) => {
      this.pendingInputs.set(userId, { chatId, resolve });
    });
  }

  private async startPersonalLogin(userId: number, chatId: number): Promise<void> {
    try {
      await this.userClient.login(userId, (question) => this.waitForInput(userId, chatId, question));
      await this.state.setAuthorized(userId, true);
      await this.api.sendMessage(
        chatId,
        "Telegram account verified. Source history, item selection and transfers are now unlocked.",
      );
    } catch (error) {
      this.pendingInputs.delete(userId);
      logger.warn({ userId, err: error }, "Telegram login failed");
      await this.api.sendMessage(
        chatId,
        `Telegram login failed: ${safeError(error)}\nNo login value was saved in bot state.`,
      );
    }
  }

  private async handleCallback(callback: TelegramCallbackQuery): Promise<void> {
    const userId = callback.from.id;
    const data = callback.data ?? "";
    const chatId = callback.message?.chat.id;
    if (chatId === undefined) {
      await this.api.answerCallbackQuery(callback.id);
      return;
    }

    if (data.startsWith("lang:")) {
      const language = data.slice("lang:".length) as LanguageCode;
      if (!languageOptions.some((option) => option.code === language)) {
        await this.api.answerCallbackQuery(callback.id, "Unknown language");
        return;
      }
      await this.state.setLanguage(userId, language);
      await this.api.answerCallbackQuery(callback.id, "Language updated");
      await this.api.sendMessage(
        chatId,
        translate(language, "languageSet", { language: languageLabel(language) }),
        { replyMarkup: this.languageKeyboard(language) },
      );
      return;
    }

    if (data.startsWith("type:")) {
      const type = data.slice("type:".length) as ContentType;
      if (!contentButtons.some((button) => button.value === type)) {
        await this.api.answerCallbackQuery(callback.id, "Unknown content type");
        return;
      }
      await this.api.answerCallbackQuery(callback.id, "Scanning Telegram history...");
      void this.discoverItems(userId, chatId, type);
      return;
    }

    if (data.startsWith("pick:")) {
      await this.handlePickCallback(callback, userId, chatId, data.slice(5));
      return;
    }

    if (data.startsWith("speed:")) {
      const speed = Number(data.slice("speed:".length));
      if (!Number.isFinite(speed) || speed < 0.1 || speed > 10) {
        await this.api.answerCallbackQuery(callback.id, "Unknown transfer speed");
        return;
      }
      await this.state.setTransferSpeed(userId, speed);
      await this.api.answerCallbackQuery(callback.id, `Transfer speed set to ${speed}x`);
      await this.api.sendMessage(
        chatId,
        `Transfer speed set to ${formatSpeed(speed)}.\nThis applies to your next and running transfer.`,
        { replyMarkup: this.transferSpeedKeyboard(speed) },
      );
      return;
    }

    await this.api.answerCallbackQuery(callback.id);
  }

  private async discoverItems(userId: number, chatId: number, type: ContentType): Promise<void> {
    const source = this.state.getUser(userId).source;
    if (!source) {
      await this.api.sendMessage(chatId, "Send a source URL first.");
      return;
    }

    try {
      await this.api.sendMessage(chatId, `Scanning ${contentLabel(type)} history...`);
      const user = this.state.getUser(userId);
      const result = await this.userClient.discover(userId, source, type, {
        filterText: user.filterText,
        maxFileSizeMb: user.maxFileSizeMb,
      });
      await this.state.setAvailable(userId, type, result.items, result.latestMessageId);
      if (!result.items.length) {
        await this.api.sendMessage(chatId, `No ${contentLabel(type).toLowerCase()} were found in ${source.label}.`);
        return;
      }
      await this.sendSelectionPage(userId, chatId, 0, result.truncated);
    } catch (error) {
      await this.api.sendMessage(chatId, `Could not scan source: ${safeError(error)}`);
    }
  }

  private async handlePickCallback(
    callback: TelegramCallbackQuery,
    userId: number,
    chatId: number,
    action: string,
  ): Promise<void> {
    const user = this.state.getUser(userId);
    if (!user.available.length) {
      await this.api.answerCallbackQuery(callback.id, "Scan a content type first");
      return;
    }

    if (action === "all") {
      await this.state.setSelection(userId, user.available.map((item) => item.id));
      await this.api.answerCallbackQuery(callback.id, `${user.available.length} items selected`);
      await this.sendSelectionPage(userId, chatId, 0, false);
      return;
    }
    if (action === "none") {
      await this.state.setSelection(userId, []);
      await this.api.answerCallbackQuery(callback.id, "Selection cleared");
      await this.sendSelectionPage(userId, chatId, 0, false);
      return;
    }
    if (action === "queue") {
      if (!user.selectedIds.length) {
        await this.api.answerCallbackQuery(callback.id, "Select at least one item");
        return;
      }
      await this.state.createQueue(userId);
      await this.api.answerCallbackQuery(callback.id, "Queue created");
      await this.api.sendMessage(
        chatId,
        `Queue ready: ${user.queue.length} items.\nNow send .sendhere inside the exact destination group, channel or forum topic.`,
      );
      return;
    }
    if (action.startsWith("page:")) {
      const page = Number(action.slice(5));
      await this.api.answerCallbackQuery(callback.id);
      await this.sendSelectionPage(userId, chatId, Number.isSafeInteger(page) ? page : 0, false);
      return;
    }
    if (action.startsWith("toggle:")) {
      const itemId = action.slice(7);
      const selected = new Set(user.selectedIds);
      if (selected.has(itemId)) selected.delete(itemId);
      else selected.add(itemId);
      await this.state.setSelection(userId, [...selected]);
      await this.api.answerCallbackQuery(callback.id, `${selected.size} selected`);
      await this.sendSelectionPage(userId, chatId, 0, false);
      return;
    }
    await this.api.answerCallbackQuery(callback.id);
  }

  private async sendSelectionPage(
    userId: number,
    chatId: number,
    page: number,
    truncated: boolean,
  ): Promise<void> {
    const user = this.state.getUser(userId);
    const pageSize = 10;
    const pageCount = Math.max(1, Math.ceil(user.available.length / pageSize));
    const safePage = Math.max(0, Math.min(page, pageCount - 1));
    const items = user.available.slice(safePage * pageSize, (safePage + 1) * pageSize);
    const selected = new Set(user.selectedIds);
    const lines = [
      `${contentLabel(user.contentType ?? "other")} found: ${user.available.length}`,
      `Selected: ${selected.size}`,
      truncated ? "History list reached the configured discovery limit." : "",
      "",
      ...items.map(
        (item, index) =>
          `${safePage * pageSize + index + 1}. ${selected.has(item.id) ? "[x]" : "[ ]"} ${item.name}`,
      ),
      "",
      "Tap an item to select or deselect it. Queue order follows the history order.",
    ].filter(Boolean);

    await this.api.sendMessage(chatId, lines.join("\n"), {
      replyMarkup: this.selectionKeyboard(items, selected, safePage, pageCount),
    });
  }

  private async startTransfer(
    userId: number,
    notifyChatId: number,
    notifyThreadId?: number,
  ): Promise<void> {
    const existingRun = this.transferRuns.get(userId);
    if (existingRun) {
      if (!existingRun.cancelled) return;
      await existingRun.done;
    }
    const initial = this.state.getUser(userId);
    if (!initial.authorized || !initial.source || !initial.target || !initial.queue.length) {
      await this.api.sendMessage(
        notifyChatId,
        "Transfer is not ready. Complete /login, source selection, item queue, then .sendhere.",
        { threadId: notifyThreadId },
      );
      return;
    }

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const transferRun: TransferRun = {
      cancelled: false,
      done,
      resolveDone,
      lastActivityAt: Date.now(),
      operationInFlight: false,
    };
    this.transferRuns.set(userId, transferRun);
    await this.state.setRunning(userId, true);
    const shouldRecordHistory = initial.queue.some((item) => item.status !== "completed");
    try {
      const progress = await this.api.sendMessage(
        notifyChatId,
        this.progressText(this.state.getUser(userId), undefined),
        { threadId: notifyThreadId },
      );
      await this.state.setProgressMessage(userId, {
        chatId: notifyChatId,
        messageId: progress.message_id,
      });

      const workers = Array.from({ length: MAX_TRANSFER_WORKERS }, (_, workerIndex) =>
        this.processTransferQueue(userId, transferRun, workerIndex),
      );
      await Promise.all([
        ...workers,
        this.watchTransferHealth(userId, transferRun, notifyChatId, notifyThreadId),
      ]);

      const finalUser = this.state.getUser(userId);
      if (!transferRun.cancelled && finalUser.running) {
        await this.state.setRunning(userId, false);
        await this.updateProgress(userId);
        if (shouldRecordHistory) {
          const completed = finalUser.queue.filter((item) => item.status === "completed").length;
          const failed = finalUser.queue.filter((item) => item.status === "failed").length;
          await this.state.recordTransfer(userId, {
            at: new Date().toISOString(),
            destination: finalUser.target?.title ?? String(finalUser.target?.chatId ?? "unknown"),
            total: finalUser.queue.length,
            sent: completed,
            failed,
            speed: finalUser.transferSpeed,
          });
        }
        if (finalUser.notifyOnComplete) {
          await this.api.sendMessage(notifyChatId, this.summaryText(this.state.getUser(userId)), {
            threadId: notifyThreadId,
          });
        }
      } else if (!transferRun.cancelled) {
        await this.api.sendMessage(notifyChatId, "Transfer paused. Completed items are saved; use /resume to continue.", {
          threadId: notifyThreadId,
        });
      }
    } catch (error) {
      if (!transferRun.cancelled) {
        await this.state.setRunning(userId, false);
        await this.state.setError(userId, safeError(error));
        await this.api.sendMessage(notifyChatId, `Transfer stopped safely: ${safeError(error)}`, {
          threadId: notifyThreadId,
        });
      }
    } finally {
      if (this.transferRuns.get(userId) === transferRun) {
        this.transferRuns.delete(userId);
      }
      transferRun.resolveDone();
    }
  }

  private async processTransferQueue(
    userId: number,
    transferRun: TransferRun,
    workerIndex: number,
  ): Promise<void> {
    while (!transferRun.cancelled && this.state.getUser(userId).running) {
      const user = this.state.getUser(userId);
      const speed = user.transferSpeed;
      if (workerIndex >= this.transferWorkerCount(speed)) {
        await pause(250);
        continue;
      }
      const pendingItems = await this.state.claimPending(
        userId,
        user.target?.threadId === undefined ? TRANSFER_BATCH_SIZE : 1,
      );
      if (!pendingItems.length) {
        return;
      }

      transferRun.lastActivityAt = Date.now();
      await this.updateProgress(userId, pendingItems[0]);
      for (const item of pendingItems) {
        if (transferRun.cancelled || !this.state.getUser(userId).running) {
          await this.state.setItemStatus(userId, item.id, "pending");
          continue;
        }

        const current = this.state.getUser(userId);
        const heartbeat: Heartbeat = () => {
          transferRun.lastActivityAt = Date.now();
        };
        transferRun.operationInFlight = true;
        heartbeat();
        try {
          await this.userClient.sendItem(
            userId,
            current.source!,
            current.target!,
            item,
            () => transferRun.cancelled,
            speed,
            heartbeat,
          );
          if (!this.isCurrentTransferRun(userId, transferRun)) return;
          await this.state.markItemSent(userId, item);
        } catch (error) {
          if (!this.isCurrentTransferRun(userId, transferRun)) return;
          const stopped = transferRun.cancelled || !this.state.getUser(userId).running;
          if (stopped) {
            await this.state.setItemStatus(userId, item.id, "pending");
            continue;
          }

          const status = error instanceof UncertainTransferError ? "uncertain" : "failed";
          await this.state.setItemStatus(userId, item.id, status, safeError(error));
          await this.state.setError(userId, safeError(error));
          logger.warn(
            { userId, itemId: item.id, status, err: error },
            "Transfer item failed",
          );
        } finally {
          transferRun.operationInFlight = false;
          transferRun.lastActivityAt = Date.now();
        }
        await this.updateProgress(userId, item);
        if (!transferRun.cancelled) {
          await pause(this.transferDelay(this.state.getUser(userId).transferSpeed));
        }
      }
      await this.updateProgress(userId);
    }
  }

  private isCurrentTransferRun(userId: number, transferRun: TransferRun): boolean {
    return this.transferRuns.get(userId) === transferRun;
  }

  private startLiveWatcher(
    userId: number,
    notifyChatId: number,
    notifyThreadId?: number,
  ): void {
    if (this.liveWatchers.has(userId)) return;

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const watcher: LiveWatcher = {
      cancelled: false,
      done,
      resolveDone,
      notifyChatId,
      notifyThreadId,
    };
    this.liveWatchers.set(userId, watcher);
    void this.watchLiveSource(userId, watcher).finally(() => {
      if (this.liveWatchers.get(userId) === watcher) {
        this.liveWatchers.delete(userId);
      }
      watcher.resolveDone();
    });
  }

  private async stopLiveWatcher(userId: number): Promise<void> {
    const watcher = this.liveWatchers.get(userId);
    if (!watcher) return;
    watcher.cancelled = true;
    await watcher.done;
  }

  private async restoreLiveWatchersAndQueues(): Promise<void> {
    for (const user of this.state.listUsers()) {
      if (
        user.liveMode &&
        user.source &&
        user.contentType &&
        user.authorized
      ) {
        this.startLiveWatcher(user.userId, user.userId);
      }
      if (
        user.target &&
        user.source &&
        user.authorized &&
        user.queue.some((item) => item.status === "pending") &&
        !user.queue.some((item) => item.status === "uncertain")
      ) {
        void this.startTransfer(user.userId, user.userId, user.target.threadId);
      }
    }
  }

  private async watchLiveSource(userId: number, watcher: LiveWatcher): Promise<void> {
    while (!watcher.cancelled && this.state.getUser(userId).liveMode) {
      await pause(LIVE_POLL_INTERVAL_MS);
      if (watcher.cancelled || !this.state.getUser(userId).liveMode) return;

      const user = this.state.getUser(userId);
      if (!user.authorized || !user.source || !user.contentType) continue;

      try {
        const result = await this.userClient.discover(userId, user.source, user.contentType, {
          filterText: user.filterText,
          maxFileSizeMb: user.maxFileSizeMb,
          minMessageId: user.lastSeenMessageId,
        });
        const added = await this.state.appendLiveItems(
          userId,
          result.items,
          result.latestMessageId,
        );
        if (added > 0) {
          const current = this.state.getUser(userId);
          await this.api.sendMessage(
            watcher.notifyChatId,
            `Live update: ${added} new ${contentLabel(user.contentType).toLowerCase()} added.\nQueue: ${current.queue.length} items.`,
            { threadId: watcher.notifyThreadId },
          );
          if (
            current.target &&
            !this.transferRuns.has(userId) &&
            current.queue.some((item) => item.status === "pending")
          ) {
            void this.startTransfer(userId, watcher.notifyChatId, watcher.notifyThreadId);
          }
        }
      } catch (error) {
        await this.state.setError(userId, safeError(error));
        logger.warn({ userId, err: error }, "Live source poll failed; watcher will continue");
      }
    }
  }

  private async watchTransferHealth(
    userId: number,
    transferRun: TransferRun,
    notifyChatId: number,
    notifyThreadId?: number,
  ): Promise<void> {
    while (!transferRun.cancelled && this.state.getUser(userId).running) {
      await pause(30_000);
      if (transferRun.cancelled || !this.state.getUser(userId).running) return;

      const user = this.state.getUser(userId);
      const hasActiveItems = user.queue.some(
        (item) => item.status === "pending" || item.status === "processing",
      );
      if (!hasActiveItems) return;

      // A long Telegram upload is healthy work, not a stall. The transfer
      // operation sends heartbeats while it is in flight, and the watchdog
      // never disconnects an active request.
      if (transferRun.operationInFlight) continue;

      if (Date.now() - transferRun.lastActivityAt <= TRANSFER_STALL_TIMEOUT_MS) {
        continue;
      }

      transferRun.cancelled = true;
      await this.state.recoverProcessing(userId);
      await this.state.setRunning(userId, false);
      await this.state.setError(
        userId,
        `Transfer watchdog stopped a stalled Telegram operation after ${Math.round(
          TRANSFER_STALL_TIMEOUT_MS / 60_000,
        )} minutes`,
      );
      await this.api.sendMessage(
        notifyChatId,
        "Transfer paused safely because no worker progress was detected. The queue is saved and will resume automatically after the Telegram connection recovers.",
        { threadId: notifyThreadId },
      );
      void this.startTransfer(userId, notifyChatId, notifyThreadId);
      return;
    }
  }

  private async stopExistingTransfer(userId: number): Promise<void> {
    const transferRun = this.transferRuns.get(userId);
    if (!transferRun) {
      await this.state.setRunning(userId, false);
      await this.state.recoverProcessing(userId);
      return;
    }

    transferRun.cancelled = true;
    await this.state.setRunning(userId, false);
    await this.userClient.stopTransfer(userId);
    const finished = await Promise.race([
      transferRun.done.then(() => true),
      pause(TRANSFER_STOP_WAIT_MS).then(() => false),
    ]);
    if (finished) {
      await this.state.recoverProcessing(userId);
      if (this.transferRuns.get(userId) === transferRun) {
        this.transferRuns.delete(userId);
      }
      return;
    }

    // Do not delete a live run after an arbitrary timeout. Deleting it allows
    // /on to start a second worker while the old Telegram request is still
    // running, which is the source of duplicate sends and stale callbacks.
    logger.warn({ userId }, "Transfer is still shutting down; keeping run locked");
  }

  private transferWorkerCount(speed: number): number {
    return Math.min(MAX_TRANSFER_WORKERS, Math.max(1, Math.ceil(speed)));
  }

  private transferDelay(speed: number): number {
    return speed >= 2 ? 0 : Math.max(0, Math.round(350 / speed));
  }

  private async updateProgress(userId: number, currentItem?: QueueItem): Promise<void> {
    const user = this.state.getUser(userId);
    const progress = user.progressMessage;
    if (!progress) return;
    const now = Date.now();
    const forceUpdate = currentItem === undefined;
    const lastUpdate = this.lastProgressUpdateAt.get(userId) ?? 0;
    if (!forceUpdate && now - lastUpdate < 1_500) return;
    try {
      await this.api.editMessageText(
        progress.chatId,
        progress.messageId,
        this.progressText(user, currentItem),
      );
      this.lastProgressUpdateAt.set(userId, Date.now());
    } catch (error) {
      logger.debug({ userId, err: error }, "Could not edit Telegram progress message");
    }
  }

  private progressText(user: UserState, currentItem?: QueueItem): string {
    const total = user.queue.length;
    const completed = user.queue.filter((item) => item.status === "completed").length;
    const width = 10;
    const filled = total ? Math.round((completed / total) * width) : 0;
    const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
    return [
      "Sending queue...",
      `Speed: ${formatSpeed(user.transferSpeed)}`,
      `[${bar}] ${completed}/${total}`,
      currentItem ? `Sending: ${currentItem.name}` : "Preparing next item...",
    ].join("\n");
  }

  private summaryText(user: UserState): string {
    const completed = user.queue.filter((item) => item.status === "completed").length;
    const failed = user.queue.filter((item) => item.status === "failed").length;
    const uncertain = user.queue.filter((item) => item.status === "uncertain").length;
    return [
      "Transfer Completed",
      "",
      `Total: ${user.queue.length}`,
      `Sent: ${completed}`,
      `Failed: ${failed}`,
      `Uncertain: ${uncertain}`,
      uncertain
        ? "Some items were not retried automatically because Telegram delivery could not be confirmed. Verify them before /retry_uncertain."
        : "",
      "Skipped: 0",
    ].filter(Boolean).join("\n");
  }

  private contentKeyboard() {
    return {
      inline_keyboard: [
        contentButtons.slice(0, 3).map((button) => ({
          text: button.text,
          callback_data: `type:${button.value}`,
        })),
        contentButtons.slice(3).map((button) => ({
          text: button.text,
          callback_data: `type:${button.value}`,
        })),
      ],
    };
  }

  private transferSpeedKeyboard(selectedSpeed: number) {
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let index = 0; index < transferSpeeds.length; index += 5) {
      rows.push(
        transferSpeeds.slice(index, index + 5).map((speed) => ({
          text: `${speed.speed === selectedSpeed ? "✓ " : ""}${speed.icon} ${formatSpeed(speed.speed)}`,
          callback_data: `speed:${speed.speed}`,
        })),
      );
    }
    return { inline_keyboard: rows };
  }

  private languageKeyboard(selectedLanguage: LanguageCode) {
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let index = 0; index < languageOptions.length; index += 2) {
      rows.push(
        languageOptions.slice(index, index + 2).map((option) => ({
          text: `${option.code === selectedLanguage ? "✓ " : ""}${option.label}`,
          callback_data: `lang:${option.code}`,
        })),
      );
    }
    return { inline_keyboard: rows };
  }

  private queueText(user: UserState): string {
    if (!user.queue.length) return translate(user.language, "queueEmpty");
    const counts = {
      completed: user.queue.filter((item) => item.status === "completed").length,
      pending: user.queue.filter((item) => item.status === "pending").length,
      processing: user.queue.filter((item) => item.status === "processing").length,
      failed: user.queue.filter((item) => item.status === "failed").length,
      uncertain: user.queue.filter((item) => item.status === "uncertain").length,
    };
    const preview = user.queue
      .filter((item) => item.status !== "completed")
      .slice(0, 15)
      .map((item, index) => `${index + 1}. ${item.name} — ${item.status}`)
      .join("\n");
    return [
      `Queue: ${user.queue.length}`,
      `Completed: ${counts.completed}`,
      `Processing: ${counts.processing}`,
      `Pending: ${counts.pending}`,
      `Failed: ${counts.failed}`,
      `Uncertain: ${counts.uncertain}`,
      "",
      preview || "All queued items are completed.",
    ].join("\n");
  }

  private historyText(user: UserState): string {
    if (!user.history.length) return translate(user.language, "noHistory");
    const items = user.history
      .slice(0, 10)
      .map(
        (record) =>
          `${new Date(record.at).toLocaleString()} — ${record.destination}\nSent: ${record.sent}/${record.total}, failed: ${record.failed}, speed: ${formatSpeed(record.speed)}`,
      )
      .join("\n");
    return translate(user.language, "history", { items });
  }

  private selectionKeyboard(
    items: QueueItem[],
    selected: Set<string>,
    page: number,
    pageCount: number,
  ) {
    const rows = items.map((item) => [
      {
        text: `${selected.has(item.id) ? "[x]" : "[ ]"} ${item.name.slice(0, 36)}`,
        callback_data: `pick:toggle:${item.id}`,
      },
    ]);
    rows.push([
      { text: "Select all", callback_data: "pick:all" },
      { text: "Clear", callback_data: "pick:none" },
      { text: "Create queue", callback_data: "pick:queue" },
    ]);
    if (pageCount > 1) {
      rows.push([
        ...(page > 0
          ? [{ text: "Previous", callback_data: `pick:page:${page - 1}` }]
          : []),
        { text: `${page + 1}/${pageCount}`, callback_data: `pick:page:${page}` },
        ...(page < pageCount - 1
          ? [{ text: "Next", callback_data: `pick:page:${page + 1}` }]
          : []),
      ]);
    }
    return { inline_keyboard: rows };
  }

  private helpText(language: LanguageCode): string {
    return [
      "Personal Telegram Transfer Bot",
      "",
      translate(language, "help"),
      "",
      "1. Send /login here and complete Telegram verification.",
      "2. Send a source group/channel URL.",
      "3. Choose Files, Photos, Videos, Voice, Messages or Other Media.",
      "4. Select individual items or Select all, then Create queue.",
      "5. Send .sendhere inside the exact destination group, channel or forum topic.",
       "6. Use /transferspeed to choose one of 10 slow or 10 fast speeds.",
      "7. Use /queue, /history, /stats, /settings and /logs.",
      "8. Use /live on or /live off to control automatic new-file monitoring.",
      "9. Use /stop to pause and /on to continue, or /cancel to clear the queue.",
      "10. Uncertain deliveries are never resent automatically; verify them before /retry_uncertain.",
      "",
      "Every Telegram user has a separate session, source, destination and checkpoint.",
      "Only chats your authorized Telegram account can access are supported.",
    ].join("\n");
  }

  private statusText(user: UserState): string {
    const completed = user.queue.filter((item) => item.status === "completed").length;
    const pending = user.queue.filter((item) => item.status === "pending").length;
    const failed = user.queue.filter((item) => item.status === "failed").length;
    const uncertain = user.queue.filter((item) => item.status === "uncertain").length;
    const processing = user.queue.find((item) => item.status === "processing");
    return [
      `Account: ${user.authorized ? "verified" : "not verified"}`,
      `Live monitoring: ${user.liveMode ? "on" : "off"}`,
      `Source: ${user.source?.label ?? "not set"}`,
      `Content: ${user.contentType ? contentLabel(user.contentType) : "not selected"}`,
      `Destination: ${user.target?.title ?? (user.target ? String(user.target.chatId) : "not set")}`,
      `Forum topic: ${user.target?.threadId ?? "none"}`,
      `Queue status: ${user.running ? "running" : "paused"}`,
      `Transfer speed: ${formatSpeed(user.transferSpeed)}`,
      `Total: ${user.queue.length}`,
      `Completed: ${completed}`,
      `Pending: ${pending}`,
      `Failed: ${failed}`,
      `Uncertain: ${uncertain}`,
      `Current item: ${processing?.name ?? "none"}`,
      user.lastError ? `Last error: ${user.lastError}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private channelActorId(): number | undefined {
    const value = Number(process.env.OWNER_TELEGRAM_ID);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 240);
  return "Unknown Telegram error";
}

function formatSpeed(speed: number): string {
  return `${Number.isInteger(speed) ? speed : speed.toFixed(1)}x`;
}

function boundedEnvNumber(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback;
}

function pause(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForCancellation<T>(
  operation: Promise<T>,
  isCancelled: () => boolean,
): Promise<T> {
  if (isCancelled()) {
    throw new Error("Transfer was stopped");
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setInterval(() => {
          if (isCancelled()) {
            clearInterval(timer);
            reject(new Error("Transfer was stopped"));
          }
        }, 250);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearInterval(timer);
  }
}