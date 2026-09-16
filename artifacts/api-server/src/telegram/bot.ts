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
import { TelegramUserClient } from "./user-client";
import { parseTelegramSourceUrl } from "./url";

const contentButtons: Array<{ text: string; value: ContentType }> = [
  { text: "Files", value: "files" },
  { text: "Photos", value: "photos" },
  { text: "Videos", value: "videos" },
  { text: "Voice", value: "voice" },
  { text: "Messages", value: "messages" },
  { text: "Other Media", value: "other" },
];

interface PendingInput {
  chatId: number;
  resolve: (value: string) => void;
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
  private readonly transferLoops = new Set<number>();

  constructor(
    private readonly api: TelegramApi,
    private readonly state: StateStore,
    private readonly userClient: TelegramUserClient,
  ) {}

  async run(): Promise<void> {
    await this.state.load();
    const bot = await this.api.getMe();
    await this.api.deleteWebhook();
    logger.info(
      { username: bot.username ?? bot.first_name },
      "Telegram polling started",
    );

    const stop = () => {
      this.stopping = true;
      void this.userClient.disconnectAll();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);

    while (!this.stopping) {
      try {
        const updates = await this.api.getUpdates(this.state.offset + 1);
        for (const update of updates) {
          try {
            await this.handleUpdate(update);
          } catch (error) {
            logger.warn({ err: error, updateId: update.update_id }, "Telegram update failed");
          } finally {
            await this.state.setOffset(update.update_id);
          }
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

    if (normalized === "/myid" && isPrivate) {
      await this.api.sendMessage(message.chat.id, `Your Telegram ID is: ${userId}`);
      return true;
    }

    if (normalized === "/start" || normalized === "/help") {
      await this.api.sendMessage(message.chat.id, this.helpText());
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

    if (normalized === "/stop") {
      await this.state.setRunning(userId, false);
      await this.api.sendMessage(message.chat.id, "Transfer paused. Use /resume to continue from the saved checkpoint.");
      return true;
    }

    if (normalized === "/resume") {
      if (!isPrivate) {
        await this.api.sendMessage(message.chat.id, "Use /resume in the bot's private chat.");
        return true;
      }
      await this.state.retryFailed(userId);
      void this.startTransfer(userId, message.chat.id);
      return true;
    }

    if (normalized === "/cancel") {
      await this.state.cancelQueue(userId);
      await this.api.sendMessage(message.chat.id, "Transfer cancelled and its queue was cleared.");
      return true;
    }

    if (normalized === "/reset") {
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
      const user = this.state.getUser(userId);
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
    await this.startTransfer(userId, message.chat.id, message.message_thread_id);
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
      const result = await this.userClient.discover(userId, source, type);
      await this.state.setAvailable(userId, type, result.items);
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
        `Queue ready: ${user.selectedIds.length} items.\nNow send .sendhere inside the exact destination group, channel or forum topic.`,
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
    if (this.transferLoops.has(userId)) return;
    const initial = this.state.getUser(userId);
    if (!initial.authorized || !initial.source || !initial.target || !initial.queue.length) {
      await this.api.sendMessage(
        notifyChatId,
        "Transfer is not ready. Complete /login, source selection, item queue, then .sendhere.",
        { threadId: notifyThreadId },
      );
      return;
    }

    this.transferLoops.add(userId);
    await this.state.setRunning(userId, true);
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

      while (this.state.getUser(userId).running) {
        const user = this.state.getUser(userId);
        const item = user.queue.find((candidate) => candidate.status === "pending");
        if (!item) break;

        await this.state.setItemStatus(userId, item.id, "processing");
        await this.updateProgress(userId, item);
        try {
          const current = this.state.getUser(userId);
          await this.userClient.sendItem(userId, current.source!, current.target!, item);
          await this.state.setItemStatus(userId, item.id, "completed");
        } catch (error) {
          await this.state.setItemStatus(userId, item.id, "failed", safeError(error));
          await this.state.setError(userId, safeError(error));
          logger.warn({ userId, itemId: item.id, err: error }, "Transfer item failed");
        }
        await this.updateProgress(userId);
        await pause(350);
      }

      const finalUser = this.state.getUser(userId);
      if (finalUser.running) {
        await this.state.setRunning(userId, false);
        await this.updateProgress(userId);
        await this.api.sendMessage(notifyChatId, this.summaryText(this.state.getUser(userId)), {
          threadId: notifyThreadId,
        });
      } else {
        await this.api.sendMessage(notifyChatId, "Transfer paused. Completed items are saved; use /resume to continue.", {
          threadId: notifyThreadId,
        });
      }
    } catch (error) {
      await this.state.setRunning(userId, false);
      await this.state.setError(userId, safeError(error));
      await this.api.sendMessage(notifyChatId, `Transfer stopped safely: ${safeError(error)}`, {
        threadId: notifyThreadId,
      });
    } finally {
      this.transferLoops.delete(userId);
    }
  }

  private async updateProgress(userId: number, currentItem?: QueueItem): Promise<void> {
    const user = this.state.getUser(userId);
    const progress = user.progressMessage;
    if (!progress) return;
    try {
      await this.api.editMessageText(
        progress.chatId,
        progress.messageId,
        this.progressText(user, currentItem),
      );
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
      `[${bar}] ${completed}/${total}`,
      currentItem ? `Sending: ${currentItem.name}` : "Preparing next item...",
    ].join("\n");
  }

  private summaryText(user: UserState): string {
    const completed = user.queue.filter((item) => item.status === "completed").length;
    const failed = user.queue.filter((item) => item.status === "failed").length;
    return [
      "Transfer Completed",
      "",
      `Total: ${user.queue.length}`,
      `Sent: ${completed}`,
      `Failed: ${failed}`,
      "Skipped: 0",
    ].join("\n");
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

  private helpText(): string {
    return [
      "Personal Telegram Transfer Bot",
      "",
      "1. Send /login here and complete Telegram verification.",
      "2. Send a source group/channel URL.",
      "3. Choose Files, Photos, Videos, Voice, Messages or Other Media.",
      "4. Select individual items or Select all, then Create queue.",
      "5. Send .sendhere inside the exact destination group, channel or forum topic.",
      "6. Watch the live queue progress. Use /stop, /resume, /cancel or /status.",
      "",
      "Every Telegram user has a separate session, source, destination and checkpoint.",
      "Only chats your authorized Telegram account can access are supported.",
    ].join("\n");
  }

  private statusText(user: UserState): string {
    const completed = user.queue.filter((item) => item.status === "completed").length;
    const pending = user.queue.filter((item) => item.status === "pending").length;
    const failed = user.queue.filter((item) => item.status === "failed").length;
    const processing = user.queue.find((item) => item.status === "processing");
    return [
      `Account: ${user.authorized ? "verified" : "not verified"}`,
      `Source: ${user.source?.label ?? "not set"}`,
      `Content: ${user.contentType ? contentLabel(user.contentType) : "not selected"}`,
      `Destination: ${user.target?.title ?? (user.target ? String(user.target.chatId) : "not set")}`,
      `Forum topic: ${user.target?.threadId ?? "none"}`,
      `Queue status: ${user.running ? "running" : "paused"}`,
      `Total: ${user.queue.length}`,
      `Completed: ${completed}`,
      `Pending: ${pending}`,
      `Failed: ${failed}`,
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

function pause(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}