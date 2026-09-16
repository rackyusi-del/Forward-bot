import type {
  TelegramBot,
  TelegramMessage,
  TelegramUpdate,
} from "./types";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramApiError extends Error {
  readonly errorCode?: number;
  readonly retryAfter?: number;

  constructor(
    message: string,
    options?: { errorCode?: number; retryAfter?: number },
  ) {
    super(message);
    this.name = "TelegramApiError";
    this.errorCode = options?.errorCode;
    this.retryAfter = options?.retryAfter;
  }
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class TelegramApi {
  private readonly endpoint: string;

  constructor(token: string) {
    this.endpoint = `https://api.telegram.org/bot${token}`;
  }

  async call<T>(
    method: string,
    payload: Record<string, unknown> = {},
    options: { retries?: number; longPoll?: boolean } = {},
  ): Promise<T> {
    const retries = options.retries ?? 3;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(`${this.endpoint}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(options.longPoll ? 35_000 : 15_000),
        });
        const data = (await response.json()) as TelegramApiResponse<T>;

        if (data.ok && data.result !== undefined) {
          return data.result;
        }

        const retryAfter = data.parameters?.retry_after;
        if (
          (retryAfter !== undefined ||
            response.status >= 500 ||
            data.error_code === 429) &&
          attempt < retries
        ) {
          await sleep(
            retryAfter !== undefined
              ? retryAfter * 1_000
              : Math.min(30_000, 1_000 * 2 ** attempt),
          );
          continue;
        }

        throw new TelegramApiError(
          data.description ?? `Telegram API ${method} failed`,
          { errorCode: data.error_code, retryAfter },
        );
      } catch (error) {
        if (error instanceof TelegramApiError || attempt >= retries) {
          throw error;
        }
        await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
      }
    }

    throw new Error(`Telegram API ${method} exhausted retries`);
  }

  getMe() {
    return this.call<TelegramBot>("getMe");
  }

  setMyCommands(commands: Array<{ command: string; description: string }>) {
    return this.call<boolean>("setMyCommands", { commands });
  }

  deleteWebhook() {
    return this.call<boolean>("deleteWebhook", { drop_pending_updates: false });
  }

  getUpdates(offset: number) {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      {
        offset,
        timeout: 25,
        allowed_updates: ["message", "channel_post", "callback_query"],
      },
      { retries: 2, longPoll: true },
    );
  }

  sendMessage(
    chatId: number,
    text: string,
    options: {
      replyMarkup?: Record<string, unknown>;
      threadId?: number;
    } = {},
  ) {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      message_thread_id: options.threadId,
      reply_markup: options.replyMarkup,
      disable_web_page_preview: true,
    });
  }

  editMessageText(chatId: number, messageId: number, text: string) {
    return this.call<TelegramMessage | boolean>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
    });
  }

  deleteMessage(chatId: number, messageId: number) {
    return this.call<boolean>("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string) {
    return this.call<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }
}