import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { logger } from "../lib/logger";
import type { ContentFilter, SourceConfig, TargetConfig } from "./state";

type Prompt = (question: string) => Promise<string>;
type Progress = (message: string) => Promise<void>;

interface MigrationProgress {
  [key: string]: number;
}

export class TelegramUserClient {
  private readonly dataDirectory: string;
  private readonly sessionPath: string;
  private readonly progressPath: string;
  private client?: TelegramClient;
  private migrationRunning = false;

  constructor(dataDirectory = process.env.DATA_DIR ?? "./data") {
    this.dataDirectory = dataDirectory;
    this.sessionPath = path.join(dataDirectory, "telegram-user.session");
    this.progressPath = path.join(dataDirectory, "telegram-migration-progress.json");
  }

  get isMigrationRunning(): boolean {
    return this.migrationRunning;
  }

  async login(prompt: Prompt): Promise<void> {
    const apiId = this.getApiId();
    const apiHash = process.env.TELEGRAM_API_HASH?.trim();
    if (!apiHash) {
      throw new Error("TELEGRAM_API_HASH is not configured in Railway Variables");
    }

    const session = await this.readSession();
    const client = new TelegramClient(
      new StringSession(session),
      apiId,
      apiHash,
      { connectionRetries: 5 },
    );

    await client.start({
      phoneNumber: async () => prompt("Send your Telegram phone number, including country code:"),
      phoneCode: async () => prompt("Send the Telegram verification code here:"),
      password: async () => prompt("Send your Telegram 2FA password here:"),
      onError: (error) => logger.warn({ err: error }, "Telegram user login failed"),
    });

    const savedSession = (client.session as StringSession).save();
    await this.saveSession(savedSession);
    this.client = client;
    logger.info("Telegram personal-account session connected");
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = undefined;
    }
  }

  async migrate(
    source: SourceConfig,
    target: TargetConfig,
    filter: ContentFilter,
    progress: Progress,
  ): Promise<{ scanned: number; sent: number }> {
    if (this.migrationRunning) {
      throw new Error("A file migration is already running");
    }

    const client = await this.getClient();
    this.migrationRunning = true;
    let scanned = 0;
    let sent = 0;

    try {
      const sourceEntity = await client.getInputEntity(source.chatId);
      const targetEntity = await client.getInputEntity(target.chatId);
      const progressState = await this.readProgress();
      const progressKey = `${String(source.chatId)}:${target.chatId}:${filter}`;
      const lastMessageId = progressState[progressKey] ?? 0;

      for await (const message of client.iterMessages(sourceEntity, {
        reverse: true,
        minId: lastMessageId || undefined,
      })) {
        scanned += 1;
        const messageId = Number(message.id);
        if (messageId <= lastMessageId) {
          continue;
        }

        if (this.matchesFilter(message, filter) && message.media) {
          await client.sendFile(targetEntity, {
            file: message.media,
            caption: message.message || undefined,
            forceDocument: filter === "files",
            replyTo: target.threadId,
          });
          sent += 1;
          await pause(700);
        }

        progressState[progressKey] = messageId;
        await this.writeProgress(progressState);

        if (scanned % 25 === 0) {
          await progress(`Migration progress: scanned ${scanned}, sent ${sent} files.`);
        }
      }

      await progress(`Migration complete: scanned ${scanned}, sent ${sent} files.`);
      return { scanned, sent };
    } finally {
      this.migrationRunning = false;
    }
  }

  private async getClient(): Promise<TelegramClient> {
    if (this.client) {
      return this.client;
    }

    const apiHash = process.env.TELEGRAM_API_HASH?.trim();
    const client = new TelegramClient(
      new StringSession(await this.readSession()),
      this.getApiId(),
      apiHash ?? "",
      { connectionRetries: 5 },
    );
    await client.connect();
    if (!(await client.checkAuthorization())) {
      throw new Error("Telegram personal account is not logged in. Send /login first.");
    }
    this.client = client;
    return client;
  }

  private getApiId(): number {
    const apiId = Number(process.env.TELEGRAM_API_ID);
    if (!Number.isSafeInteger(apiId) || apiId <= 0) {
      throw new Error("TELEGRAM_API_ID is not configured in Railway Variables");
    }
    return apiId;
  }

  private matchesFilter(message: any, filter: ContentFilter): boolean {
    if (!message.media) {
      return false;
    }
    if (filter === "everything" || filter === "files") {
      return true;
    }
    if (filter === "photos") {
      return Boolean(message.photo);
    }
    if (filter === "videos") {
      return Boolean(message.video || message.gif || message.videoNote);
    }
    return false;
  }

  private async readSession(): Promise<string> {
    try {
      return (await readFile(this.sessionPath, "utf8")).trim();
    } catch {
      return "";
    }
  }

  private async saveSession(session: string): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    await writeFile(this.sessionPath, session, { encoding: "utf8", mode: 0o600 });
  }

  private async readProgress(): Promise<MigrationProgress> {
    try {
      return JSON.parse(await readFile(this.progressPath, "utf8")) as MigrationProgress;
    } catch {
      return {};
    }
  }

  private async writeProgress(progress: MigrationProgress): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    await writeFile(this.progressPath, JSON.stringify(progress, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}