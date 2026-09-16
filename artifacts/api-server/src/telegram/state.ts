import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../lib/logger";

export type ContentType =
  | "files"
  | "photos"
  | "videos"
  | "voice"
  | "messages"
  | "other";

export type QueueItemStatus = "pending" | "processing" | "completed" | "failed";

export interface SourceConfig {
  chatId: number | string;
  label: string;
}

export interface TargetConfig {
  chatId: number;
  title?: string;
  threadId?: number;
}

export interface QueueItem {
  id: string;
  messageId: number;
  type: ContentType;
  name: string;
  date: number;
  status: QueueItemStatus;
  error?: string;
}

export interface UserState {
  userId: number;
  authorized: boolean;
  source?: SourceConfig;
  contentType?: ContentType;
  available: QueueItem[];
  selectedIds: string[];
  queue: QueueItem[];
  target?: TargetConfig;
  running: boolean;
  progressMessage?: { chatId: number; messageId: number };
  lastError?: string;
  updatedAt: string;
}

interface PersistedState {
  offset: number;
  users: Record<string, UserState>;
  updatedAt: string;
}

const emptyState = (): PersistedState => ({
  offset: 0,
  users: {},
  updatedAt: new Date().toISOString(),
});

const emptyUser = (userId: number): UserState => ({
  userId,
  authorized: false,
  available: [],
  selectedIds: [],
  queue: [],
  running: false,
  updatedAt: new Date().toISOString(),
});

export class StateStore {
  private readonly statePath: string;
  private state: PersistedState = emptyState();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDirectory = process.env.DATA_DIR ?? "./data") {
    this.statePath = path.join(dataDirectory, "forwarder-state.json");
  }

  async load(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(this.statePath, "utf8")) as PersistedState;
      for (const user of Object.values(this.state.users)) {
        user.running = false;
        for (const item of user.queue) {
          if (item.status === "processing") item.status = "pending";
        }
      }
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code !== "ENOENT") {
        logger.warn({ err: error }, "Could not read saved Telegram state");
      }
      this.state = emptyState();
    }
  }

  get offset() {
    return this.state.offset;
  }

  getUser(userId: number): UserState {
    const key = String(userId);
    if (!this.state.users[key]) this.state.users[key] = emptyUser(userId);
    return this.state.users[key];
  }

  async save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    for (const user of Object.values(this.state.users)) {
      user.updatedAt = this.state.updatedAt;
    }
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      const directory = path.dirname(this.statePath);
      await mkdir(directory, { recursive: true });
      const temporaryPath = `${this.statePath}.tmp`;
      await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.statePath);
    });
    await this.writeChain;
  }

  async setOffset(offset: number) {
    this.state.offset = offset;
    await this.save();
  }

  async setAuthorized(userId: number, authorized: boolean) {
    this.getUser(userId).authorized = authorized;
    await this.save();
  }

  async setSource(userId: number, source: SourceConfig) {
    const user = this.getUser(userId);
    user.source = source;
    user.contentType = undefined;
    user.available = [];
    user.selectedIds = [];
    user.queue = [];
    user.target = undefined;
    user.lastError = undefined;
    await this.save();
  }

  async setAvailable(userId: number, contentType: ContentType, available: QueueItem[]) {
    const user = this.getUser(userId);
    user.contentType = contentType;
    user.available = available;
    user.selectedIds = [];
    user.queue = [];
    user.target = undefined;
    user.lastError = undefined;
    await this.save();
  }

  async setSelection(userId: number, selectedIds: string[]) {
    this.getUser(userId).selectedIds = selectedIds;
    await this.save();
  }

  async createQueue(userId: number) {
    const user = this.getUser(userId);
    const selected = new Set(user.selectedIds);
    user.queue = user.available
      .filter((item) => selected.has(item.id))
      .map((item) => ({ ...item, status: "pending", error: undefined }));
    await this.save();
  }

  async setTarget(userId: number, target: TargetConfig) {
    this.getUser(userId).target = target;
    await this.save();
  }

  async setRunning(userId: number, running: boolean) {
    this.getUser(userId).running = running;
    await this.save();
  }

  async retryFailed(userId: number) {
    const user = this.getUser(userId);
    for (const item of user.queue) {
      if (item.status === "failed") {
        item.status = "pending";
        item.error = undefined;
      }
    }
    user.lastError = undefined;
    await this.save();
  }

  async setProgressMessage(
    userId: number,
    progressMessage: { chatId: number; messageId: number } | undefined,
  ) {
    this.getUser(userId).progressMessage = progressMessage;
    await this.save();
  }

  async setItemStatus(
    userId: number,
    itemId: string,
    status: QueueItemStatus,
    error?: string,
  ) {
    const item = this.getUser(userId).queue.find((candidate) => candidate.id === itemId);
    if (!item) return;
    item.status = status;
    item.error = error;
    await this.save();
  }

  async setError(userId: number, error: string | undefined) {
    this.getUser(userId).lastError = error;
    await this.save();
  }

  async cancelQueue(userId: number) {
    const user = this.getUser(userId);
    user.running = false;
    user.queue = [];
    user.selectedIds = [];
    user.target = undefined;
    user.progressMessage = undefined;
    await this.save();
  }

  async reset(userId: number) {
    const current = this.getUser(userId);
    this.state.users[String(userId)] = {
      ...emptyUser(userId),
      authorized: current.authorized,
    };
    await this.save();
  }
}