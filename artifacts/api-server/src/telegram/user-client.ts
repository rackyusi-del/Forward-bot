import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { logger } from "../lib/logger";
import type {
  ContentType,
  QueueItem,
  SourceConfig,
  TargetConfig,
} from "./state";
import { itemName, matchesContentType, messageContentType } from "./filter";

type Prompt = (question: string) => Promise<string>;
type Progress = (completed: number, total: number, name: string) => Promise<void>;
type IsCancelled = () => boolean;
// A Telegram transfer that remains unresolved can otherwise hold a worker
// forever. The timeout is per attempt; timed-out attempts disconnect the
// client and retry with a fresh connection. Increase this through
// TRANSFER_ITEM_TIMEOUT_MS for unusually large files.
const DEFAULT_TRANSFER_ITEM_TIMEOUT_MS = 120_000;
const MAX_FLOOD_WAIT_MS = 120_000;
const MAX_TRANSFER_ATTEMPTS = 6;

export interface DiscoveryResult {
  items: QueueItem[];
  truncated: boolean;
  latestMessageId?: number;
}

export class TelegramUserClient {
  private readonly dataDirectory: string;
  private readonly clients = new Map<number, TelegramClient>();
  private readonly loginLocks = new Set<number>();

  constructor(dataDirectory = process.env.DATA_DIR ?? "./data") {
    this.dataDirectory = dataDirectory;
  }

  async login(userId: number, prompt: Prompt): Promise<void> {
    if (this.loginLocks.has(userId)) {
      throw new Error("A login is already in progress for this Telegram user");
    }
    this.loginLocks.add(userId);

    try {
      const apiId = this.getApiId();
      const apiHash = this.getApiHash();
      const client = new TelegramClient(
        new StringSession(await this.readSession(userId)),
        apiId,
        apiHash,
        { connectionRetries: 5 },
      );

      await client.start({
        phoneNumber: async () => {
          const phoneNumber = await prompt(
            "📱 Send your Telegram phone number with country code.\n\nExample: +919876543210\n\n🔒 This message will be deleted immediately.",
          );
          return phoneNumber.replace(/\s+/g, "");
        },
        phoneCode: async () => {
          const phoneCode = await prompt(
            "🔢 Send the Telegram verification code.\n\nEnter it like this: 1 2 3 4 5\n(Spaces will be removed automatically.)\n\n🔒 This message will be deleted immediately.",
          );
          return phoneCode.replace(/\s+/g, "");
        },
        password: async () =>
          prompt(
            "🔐 Send your Telegram 2FA password.\n\n🔒 This message will be deleted immediately.",
          ),
        onError: (error) => logger.warn({ err: error }, "Telegram login attempt failed"),
      });

      await this.saveSession(userId, (client.session as StringSession).save());
      this.clients.set(userId, client);
      logger.info({ userId }, "Telegram personal session connected");
    } finally {
      this.loginLocks.delete(userId);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) await client.disconnect();
    this.clients.clear();
  }

  async logout(userId: number): Promise<void> {
    const client = this.clients.get(userId);
    if (client) {
      await client.disconnect();
      this.clients.delete(userId);
    }
    await unlink(this.sessionPath(userId)).catch(() => undefined);
  }

  stopTransfer(userId: number): void {
    const client = this.clients.get(userId);
    if (!client) return;

    this.abandonClient(userId, client);
  }

  async discover(
    userId: number,
    source: SourceConfig,
    type: ContentType,
    options: {
      filterText?: string;
      maxFileSizeMb?: number;
      minMessageId?: number;
    } = {},
  ): Promise<DiscoveryResult> {
    const client = await this.getClient(userId);
    const sourceEntity = await client.getInputEntity(source.chatId);
    const items: QueueItem[] = [];
    const seen = new Set<number>();
    const maxItems = Number(process.env.MAX_DISCOVERY_ITEMS ?? "25000");
    let latestMessageId = options.minMessageId ?? 0;

    for await (const message of client.iterMessages(sourceEntity, {
      reverse: true,
      minId: options.minMessageId,
    })) {
      const messageId = Number(message.id);
      if (!Number.isSafeInteger(messageId)) continue;
      latestMessageId = Math.max(latestMessageId, messageId);
      if (seen.has(messageId)) continue;
      if (!matchesContentType(message, type)) continue;
      const name = itemName(message, type, messageId);
      const fileSize = Number(message.file?.size ?? 0);
      if (
        options.maxFileSizeMb !== undefined &&
        fileSize > options.maxFileSizeMb * 1024 * 1024
      ) {
        continue;
      }
      if (
        options.filterText &&
        !name.toLowerCase().includes(options.filterText.toLowerCase())
      ) {
        continue;
      }
      seen.add(messageId);
      items.push({
        id: String(messageId),
        messageId,
        type,
        name,
        date: Number(message.date ?? 0),
        size: fileSize > 0 ? fileSize : undefined,
        status: "pending",
      });
      if (items.length >= maxItems) {
        return { items, truncated: true, latestMessageId };
      }
    }

    return { items, truncated: false, latestMessageId };
  }

  async sendItem(
    userId: number,
    source: SourceConfig,
    target: TargetConfig,
    item: QueueItem,
    isCancelled: IsCancelled = () => false,
    speed = 1,
  ): Promise<void> {
    if (isCancelled()) throw new Error("Transfer was stopped");
    const timeoutMs = transferItemTimeoutMs();

    for (let attempt = 0; attempt < MAX_TRANSFER_ATTEMPTS; attempt += 1) {
      let client: TelegramClient | undefined;
      try {
        client = await this.getClient(userId);
        await withTimeout(
          (async () => {
            const sourceEntity = await client!.getInputEntity(source.chatId);
            const targetEntity = await client!.getInputEntity(target.chatId);
            const message = await this.getMessage(client!, sourceEntity, item.messageId);
            if (!message) throw new Error("Source message is no longer available");

            if (item.type === "messages" && !message.media) {
              if (!message.message?.trim()) throw new Error("Message has no text");
              if (isCancelled()) throw new Error("Transfer was stopped");
              await client!.sendMessage(targetEntity, {
                message: message.message,
                replyTo: target.threadId,
              });
            } else if (message.media) {
              if (isCancelled()) throw new Error("Transfer was stopped");
              await client!.sendFile(targetEntity, {
                file: message.media,
                caption: message.message || undefined,
                forceDocument: item.type === "files",
                replyTo: target.threadId,
                workers: uploadWorkerCount(speed),
              });
            } else {
              throw new Error("Source media is unavailable");
            }
          })(),
          timeoutMs,
          item.name,
        );
        return;
      } catch (error) {
        if (error instanceof TransferTimeoutError && client) {
          this.abandonClient(userId, client);
        }
        if (isCancelled()) throw error;
        const seconds = floodWaitSeconds(error);
        if (seconds !== undefined) {
          logger.warn(
            { userId, itemId: item.id, waitSeconds: seconds },
            "Telegram FloodWait; pausing this item before retry",
          );
          if (attempt >= MAX_TRANSFER_ATTEMPTS - 1) throw error;
          await pause(Math.min(MAX_FLOOD_WAIT_MS, Math.max(1, seconds) * 1_000));
          continue;
        }
        if (
          !(error instanceof TransferTimeoutError) &&
          (!isRetryableTransferError(error) || attempt >= MAX_TRANSFER_ATTEMPTS - 1)
        ) {
          throw error;
        }
        await pause(retryDelayMs(attempt));
      }
    }
  }

  private abandonClient(userId: number, client: TelegramClient): void {
    if (this.clients.get(userId) !== client) return;
    this.clients.delete(userId);
    void client.disconnect().catch((error) => {
      logger.debug({ userId, err: error }, "Telegram transfer client was already disconnected");
    });
  }

  private async getClient(userId: number): Promise<TelegramClient> {
    const existing = this.clients.get(userId);
    if (existing) return existing;

    const client = new TelegramClient(
      new StringSession(await this.readSession(userId)),
      this.getApiId(),
      this.getApiHash(),
      { connectionRetries: 5 },
    );
    await client.connect();
    if (!(await client.checkAuthorization())) {
      await client.disconnect();
      throw new Error("Telegram account is not logged in. Send /login first.");
    }
    this.clients.set(userId, client);
    return client;
  }

  private async getMessage(client: TelegramClient, entity: any, messageId: number): Promise<any> {
    const result = await client.getMessages(entity, { ids: [messageId] });
    return Array.isArray(result) ? result[0] : result;
  }

  private getApiId(): number {
    const apiId = Number(process.env.API_ID ?? process.env.TELEGRAM_API_ID);
    if (!Number.isSafeInteger(apiId) || apiId <= 0) {
      throw new Error("API_ID is not configured in Railway Variables");
    }
    return apiId;
  }

  private getApiHash(): string {
    const apiHash = (process.env.API_HASH ?? process.env.TELEGRAM_API_HASH)?.trim();
    if (!apiHash) throw new Error("API_HASH is not configured in Railway Variables");
    return apiHash;
  }

  private sessionPath(userId: number) {
    return path.join(this.dataDirectory, `telegram-user-${userId}.session`);
  }

  private async readSession(userId: number): Promise<string> {
    try {
      return (await readFile(this.sessionPath(userId), "utf8")).trim();
    } catch {
      return "";
    }
  }

  private async saveSession(userId: number, session: string): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    await writeFile(this.sessionPath(userId), session, { encoding: "utf8", mode: 0o600 });
  }
}

class TransferTimeoutError extends Error {
  constructor(itemName: string, timeoutMs: number) {
    super(
      `Transfer item "${itemName.slice(0, 100)}" timed out after ${Math.round(timeoutMs / 1000)} seconds`,
    );
    this.name = "TransferTimeoutError";
  }
}

function transferItemTimeoutMs(): number {
  const configured = Number(
    process.env.TRANSFER_ITEM_TIMEOUT_MS ?? DEFAULT_TRANSFER_ITEM_TIMEOUT_MS,
  );
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_TRANSFER_ITEM_TIMEOUT_MS;
  }
  return Math.min(24 * 60 * 60_000, Math.max(30_000, Math.round(configured)));
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  itemName: string,
): Promise<T> {
  if (timeoutMs <= 0) return operation;

  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new TransferTimeoutError(itemName, timeoutMs)),
        timeoutMs,
      );
      timer.unref?.();
      void operation.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** attempt);
}

function isRetryableTransferError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /(AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED|USER_BANNED|CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|CHANNEL_PRIVATE|PEER_ID_INVALID|MESSAGE_ID_INVALID|MEDIA_EMPTY|MESSAGE_TOO_LONG|FILE_REFERENCE_EXPIRED|not logged in|no longer available)/i.test(
      message,
    )
  ) {
    return false;
  }

  return /(TIMEOUT|TIMED OUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|NETWORK|CONNECTION|UNAVAILABLE|INTERNAL|SERVER|RPC_CALL_FAIL|502|503|504|429)/i.test(
    message,
  );
}

function floodWaitSeconds(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "seconds" in error &&
    typeof (error as { seconds?: unknown }).seconds === "number"
  ) {
    return (error as { seconds: number }).seconds;
  }
  return undefined;
}

function pause(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function uploadWorkerCount(speed: number): number {
  const configured = Number(process.env.MAX_UPLOAD_WORKERS ?? "4");
  const maximum = Number.isFinite(configured)
    ? Math.min(4, Math.max(1, Math.round(configured)))
    : 4;
  return Math.min(maximum, Math.max(1, Math.ceil(speed)));
}
