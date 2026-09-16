import { logger } from "../lib/logger";
import { TelegramApi, TelegramApiError } from "./api";
import { messageMatchesFilter } from "./filter";
import {
  type ContentFilter,
  StateStore,
  type SourceConfig,
} from "./state";
import type { TelegramMessage, TelegramUpdate } from "./types";
import { TelegramUserClient } from "./user-client";
import { parseTelegramSourceUrl } from "./url";

const filterButtons: Array<{ text: string; value: ContentFilter }> = [
  { text: "Files", value: "files" },
  { text: "Photos", value: "photos" },
  { text: "Videos", value: "videos" },
  { text: "Messages", value: "messages" },
  { text: "Links", value: "links" },
  { text: "Everything", value: "everything" },
];

const filterLabels: Record<ContentFilter, string> = {
  files: "Files",
  photos: "Photos",
  videos: "Videos",
  messages: "Messages",
  links: "Links",
  everything: "Everything",
};

export async function startTelegramBot(): Promise<void> {
  const token = process.env.BOT_TOKEN?.trim();
  if (!token) {
    logger.warn("BOT_TOKEN is not set; Telegram bot listener is disabled");
    return;
  }

  const ownerId = parseOwnerId(process.env.OWNER_TELEGRAM_ID);
  if (ownerId === undefined) {
    logger.warn(
      "OWNER_TELEGRAM_ID is not set; send /myid to the bot, then add the numeric ID in Railway Variables",
    );
  }

  const bot = new ForwardingBot(
    new TelegramApi(token),
    new StateStore(),
    new TelegramUserClient(),
    ownerId,
  );
  await bot.run();
}

function parseOwnerId(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

class ForwardingBot {
  private stopping = false;
  private readonly state: StateStore;
  private pendingLoginInput?: {
    chatId: number;
    resolve: (value: string) => void;
  };
  private migrationStarted = false;

  constructor(
    private readonly api: TelegramApi,
    state: StateStore,
    private readonly userClient: TelegramUserClient,
    private readonly ownerId: number | undefined,
  ) {
    this.state = state;
  }

  async run(): Promise<void> {
    await this.state.load();
    const bot = await this.api.getMe();
    await this.api.deleteWebhook();
    logger.info(
      { username: bot.username ?? bot.first_name },
      "Telegram polling started",
    );

    process.once("SIGTERM", () => {
      this.stopping = true;
    });
    process.once("SIGINT", () => {
      this.stopping = true;
    });

    while (!this.stopping) {
      try {
        const updates = await this.api.getUpdates(this.state.current.offset + 1);
        for (const update of updates) {
          await this.handleUpdate(update);
          await this.state.setOffset(update.update_id);
        }
      } catch (error) {
        if (error instanceof TelegramApiError && error.errorCode === 409) {
          logger.error(
            "Telegram polling conflict: stop any other bot instance using the same BOT_TOKEN",
          );
        } else {
          logger.warn({ err: error }, "Telegram polling error; retrying");
        }
        await delay(3_000);
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
    if (!message) {
      return;
    }

    if (this.consumePendingLoginInput(message)) {
      return;
    }

    if (await this.handleControlMessage(message)) {
      return;
    }

    if (this.state.current.active) {
      await this.forwardIncomingMessage(message);
    }
  }

  private async handleControlMessage(message: TelegramMessage): Promise<boolean> {
    const text = message.text?.trim() ?? "";
    const normalized = text.toLowerCase();
    const isPrivate = message.chat.type === "private";
    const senderId = message.from?.id;

    if (normalized === "/myid" && isPrivate && senderId !== undefined) {
      await this.api.sendMessage(message.chat.id, `Your Telegram ID is: ${senderId}`);
      return true;
    }

    if (!this.isOwner(senderId)) {
      return false;
    }

    if (normalized === "/start" || normalized === "/help") {
      await this.api.sendMessage(message.chat.id, this.helpText());
      return true;
    }

    if (normalized === "/status") {
      await this.api.sendMessage(message.chat.id, this.statusText());
      return true;
    }

    if (normalized === "/reset") {
      await this.state.reset();
      await this.api.sendMessage(message.chat.id, "Saved source, target and job state were reset.");
      return true;
    }

    if (normalized === "/login") {
      if (!isPrivate) {
        await this.api.sendMessage(
          message.chat.id,
          "Send /login in the bot's private chat.",
          { threadId: message.message_thread_id },
        );
        return true;
      }
      if (this.ownerId === undefined || senderId !== this.ownerId) {
        return true;
      }
      void this.startPersonalLogin(message.chat.id);
      return true;
    }

    if (normalized === "/migrate") {
      if (!isPrivate) {
        await this.api.sendMessage(
          message.chat.id,
          "Send /migrate in the bot's private chat.",
          { threadId: message.message_thread_id },
        );
        return true;
      }
      void this.startMigration(message.chat.id);
      return true;
    }

    if (normalized === ".stop" || normalized === "/stop") {
      await this.state.setActive(false);
      await this.api.sendMessage(message.chat.id, "Forwarding stopped.");
      return true;
    }

    const source = parseTelegramSourceUrl(text);
    if (source && isPrivate) {
      await this.state.setSource(source);
      await this.api.sendMessage(
        message.chat.id,
        `Source saved: ${source.label}\n\nNow choose what to forward.`,
        { replyMarkup: this.filterKeyboard() },
      );
      return true;
    }

    if (normalized === ".sendhere") {
      if (isPrivate) {
        await this.api.sendMessage(
          message.chat.id,
          "Send .sendhere inside the target group or forum topic, not in this private chat.",
        );
        return true;
      }
      if (!this.state.current.source || !this.state.current.filter) {
        await this.api.sendMessage(
          message.chat.id,
          "First send a source Telegram URL in the bot chat and choose a content type.",
        );
        return true;
      }

      await this.state.setTarget({
        chatId: message.chat.id,
        title: message.chat.title,
        threadId: message.message_thread_id,
      });

      const specificMessageId = this.state.current.source.specificMessageId;
      if (specificMessageId !== undefined) {
        await this.copySpecificMessage(
          this.state.current.source,
          message.chat.id,
          message.message_thread_id,
          specificMessageId,
        );
        await this.state.setActive(false);
        await this.api.sendMessage(
          message.chat.id,
          "That specific message was copied. Send another source URL to copy another one.",
          { threadId: message.message_thread_id },
        );
      } else {
        await this.state.setActive(true);
        await this.api.sendMessage(
          message.chat.id,
          `Forwarding started: ${filterLabels[this.state.current.filter]}\nUse .stop here or in the bot chat to stop.`,
          { threadId: message.message_thread_id },
        );
        void this.startMigration(this.ownerId ?? message.chat.id);
      }
      return true;
    }

    if (source && !isPrivate) {
      await this.api.sendMessage(
        message.chat.id,
        "Send the source URL in the bot's private chat first.",
        { threadId: message.message_thread_id },
      );
      return true;
    }

    return false;
  }

  private consumePendingLoginInput(message: TelegramMessage): boolean {
    if (
      !this.pendingLoginInput ||
      message.chat.type !== "private" ||
      message.chat.id !== this.pendingLoginInput.chatId ||
      message.from?.id !== this.ownerId ||
      !message.text?.trim()
    ) {
      return false;
    }

    const pending = this.pendingLoginInput;
    this.pendingLoginInput = undefined;
    pending.resolve(message.text.trim());
    return true;
  }

  private waitForLoginInput(chatId: number, question: string): Promise<string> {
    if (this.pendingLoginInput) {
      return Promise.reject(new Error("A Telegram login prompt is already waiting for input"));
    }
    void this.api.sendMessage(chatId, question);
    return new Promise((resolve) => {
      this.pendingLoginInput = { chatId, resolve };
    });
  }

  private async startPersonalLogin(chatId: number): Promise<void> {
    try {
      await this.userClient.login((question) => this.waitForLoginInput(chatId, question));
      await this.api.sendMessage(
        chatId,
        "Personal Telegram account connected. Your old-group migration is ready.",
      );
    } catch (error) {
      await this.api.sendMessage(
        chatId,
        `Personal Telegram login failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  private async startMigration(chatId: number): Promise<void> {
    if (this.migrationStarted) {
      return;
    }
    const source = this.state.current.source;
    const target = this.state.current.target;
    const filter = this.state.current.filter;
    if (!source || !target || !filter) {
      await this.api.sendMessage(
        chatId,
        "First send the old-group URL, select Files, then send .sendhere in the new group.",
      );
      return;
    }

    this.migrationStarted = true;
    try {
      await this.userClient.migrate(
        source,
        target,
        filter,
        async (progress) => {
          await this.api.sendMessage(chatId, progress);
        },
      );
      await this.api.sendMessage(chatId, "Old-group file migration finished.");
    } catch (error) {
      await this.api.sendMessage(
        chatId,
        `Migration stopped: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      this.migrationStarted = false;
    }
  }

  private async handleCallback(callback: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
    await this.api.answerCallbackQuery(callback.id);
    const senderId = callback.from.id;
    const filter = callback.data?.replace("filter:", "") as ContentFilter | undefined;
    if (!this.isOwner(senderId) || !filter || !(filter in filterLabels)) {
      return;
    }

    await this.state.setFilter(filter);
    const chatId = callback.message?.chat.id;
    if (chatId === undefined) {
      return;
    }
    await this.api.sendMessage(
      chatId,
      `Selected: ${filterLabels[filter]}\n\nNow send .sendhere in the target group or exact forum topic.`,
    );
  }

  private async forwardIncomingMessage(message: TelegramMessage): Promise<void> {
    const source = this.state.current.source;
    const target = this.state.current.target;
    const filter = this.state.current.filter;
    if (!source || !target || !filter || !this.matchesSource(message, source)) {
      return;
    }
    if (
      source.specificMessageId !== undefined &&
      message.message_id !== source.specificMessageId
    ) {
      return;
    }
    if (!messageMatchesFilter(message, filter)) {
      return;
    }

    const key = `${message.chat.id}:${message.message_id}`;
    if (this.state.hasProcessed(key)) {
      return;
    }

    try {
      await this.api.copyMessage(
        target.chatId,
        message.chat.id,
        message.message_id,
        target.threadId,
      );
      await this.state.markProcessed(key);
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message.slice(0, 200) : "Unknown Telegram error";
      await this.state.setError(messageText);
      logger.warn(
        { err: error, sourceChatId: message.chat.id, messageId: message.message_id },
        "Could not copy Telegram message",
      );
    }
  }

  private async copySpecificMessage(
    source: SourceConfig,
    targetChatId: number,
    targetThreadId: number | undefined,
    messageId: number,
  ): Promise<void> {
    try {
      await this.api.copyMessage(targetChatId, source.chatId, messageId, targetThreadId);
      await this.state.markProcessed(`${String(source.chatId)}:${messageId}`);
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message.slice(0, 200) : "Unknown Telegram error";
      await this.state.setError(messageText);
      throw error;
    }
  }

  private matchesSource(message: TelegramMessage, source: SourceConfig): boolean {
    if (typeof source.chatId === "number") {
      return message.chat.id === source.chatId;
    }
    return message.chat.username?.toLowerCase() === source.chatId.slice(1).toLowerCase();
  }

  private isOwner(userId: number | undefined): boolean {
    return userId !== undefined && this.ownerId !== undefined && userId === this.ownerId;
  }

  private filterKeyboard(): Record<string, unknown> {
    return {
      inline_keyboard: [
        filterButtons.slice(0, 3).map(({ text, value }) => ({
          text,
          callback_data: `filter:${value}`,
        })),
        filterButtons.slice(3).map(({ text, value }) => ({
          text,
          callback_data: `filter:${value}`,
        })),
      ],
    };
  }

  private helpText(): string {
    return [
      "Personal Telegram Forwarder",
      "",
      "1. Send a source group/channel URL here.",
      "2. Choose Files, Photos, Videos, Messages, Links or Everything.",
      "3. Send .sendhere inside the target group or exact forum topic.",
      "4. Use /login to connect your personal Telegram account.",
      "5. Use /migrate to copy old files, or .stop to stop live forwarding.",
      "",
      "Use /status to view the current job and /reset to clear saved state.",
      "",
      "The personal account migration reads old messages that your account can access and uploads them without the original sender header.",
    ].join("\n");
  }

  private statusText(): string {
    const current = this.state.current;
    return [
      `Source: ${current.source?.label ?? "not set"}`,
      `Filter: ${current.filter ? filterLabels[current.filter] : "not set"}`,
      `Target: ${current.target?.title ?? (current.target ? String(current.target.chatId) : "not set")}`,
      `Forum topic: ${current.target?.threadId ?? "none"}`,
      `Running: ${current.active ? "yes" : "no"}`,
      `Processed: ${current.processedKeys.length}`,
      current.lastError ? `Last error: ${current.lastError}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}