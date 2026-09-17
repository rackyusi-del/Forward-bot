import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../lib/logger";
import type { LanguageCode } from "./i18n";

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
  size?: number;
  status: QueueItemStatus;
  error?: string;
}

export interface TransferHistory {
  at: string;
  destination: string;
  total: number;
  sent: number;
  failed: number;
  speed: number;
}

export interface UserState {
  userId: number;
  authorized: boolean;
  liveMode: boolean;
  transferSpeed: number;
  language: LanguageCode;
  notifyOnComplete: boolean;
  maxFileSizeMb?: number;
  filterText?: string;
  scheduledAt?: string;
  duplicateCount: number;
  sentItemKeys: string[];
  history: TransferHistory[];
  source?: SourceConfig;
  lastSeenMessageId?: number;
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
  liveMode: true,
  transferSpeed: 1,
  language: "en",
  notifyOnComplete: true,
  duplicateCount: 0,
  sentItemKeys: [],
  history: [],
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
  private pendingSnapshot?: string;
  private saveTimer?: NodeJS.Timeout;

  constructor(dataDirectory = process.env.DATA_DIR ?? "./data") {
    this.statePath = path.join(dataDirectory, "forwarder-state.json");
  }

  async load(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(this.statePath, "utf8")) as PersistedState;
      for (const user of Object.values(this.state.users)) {
        user.transferSpeed = normalizeTransferSpeed(user.transferSpeed);
        user.liveMode ??= true;
        user.language ??= "en";
        user.notifyOnComplete ??= true;
        user.duplicateCount ??= 0;
        user.sentItemKeys ??= [];
        user.history ??= [];
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

  listUsers(): UserState[] {
    return Object.values(this.state.users);
  }

  async save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    for (const user of Object.values(this.state.users)) {
      user.updatedAt = this.state.updatedAt;
    }
    this.pendingSnapshot = JSON.stringify(this.state, null, 2);
    if (this.saveTimer) return;

    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const snapshot = this.pendingSnapshot;
      this.pendingSnapshot = undefined;
      if (!snapshot) return;
      this.writeChain = this.writeChain
        .then(() => this.writeSnapshot(snapshot))
        .catch((error) => {
          logger.warn({ err: error }, "Could not persist Telegram state");
        });
    }, 250);
    this.saveTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const snapshot = this.pendingSnapshot;
    this.pendingSnapshot = undefined;
    if (snapshot) {
      this.writeChain = this.writeChain
        .then(() => this.writeSnapshot(snapshot))
        .catch((error) => {
          logger.warn({ err: error }, "Could not persist Telegram state");
        });
    }
    await this.writeChain;
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    const directory = path.dirname(this.statePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.statePath}.tmp`;
    await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.statePath);
  }

  async setOffset(offset: number) {
    this.state.offset = offset;
    await this.save();
  }

  async setAuthorized(userId: number, authorized: boolean) {
    this.getUser(userId).authorized = authorized;
    await this.save();
  }

  async setLiveMode(userId: number, enabled: boolean) {
    this.getUser(userId).liveMode = enabled;
    await this.save();
  }

  async setTransferSpeed(userId: number, speed: number) {
    this.getUser(userId).transferSpeed = normalizeTransferSpeed(speed);
    await this.save();
  }

  async setLanguage(userId: number, language: LanguageCode) {
    this.getUser(userId).language = language;
    await this.save();
  }

  async setNotifyOnComplete(userId: number, enabled: boolean) {
    this.getUser(userId).notifyOnComplete = enabled;
    await this.save();
  }

  async setFilter(userId: number, filterText: string | undefined) {
    this.getUser(userId).filterText = filterText?.trim() || undefined;
    await this.save();
  }

  async setMaxFileSize(userId: number, maxFileSizeMb: number | undefined) {
    this.getUser(userId).maxFileSizeMb =
      maxFileSizeMb === undefined ? undefined : Math.max(1, Math.round(maxFileSizeMb));
    await this.save();
  }

  async setScheduledAt(userId: number, scheduledAt: string | undefined) {
    this.getUser(userId).scheduledAt = scheduledAt;
    await this.save();
  }

  async setSource(userId: number, source: SourceConfig) {
    const user = this.getUser(userId);
    user.source = source;
    user.lastSeenMessageId = undefined;
    user.contentType = undefined;
    user.available = [];
    user.selectedIds = [];
    user.queue = [];
    user.target = undefined;
    user.lastError = undefined;
    await this.save();
  }

  async setAvailable(
    userId: number,
    contentType: ContentType,
    available: QueueItem[],
    lastSeenMessageId?: number,
  ) {
    const user = this.getUser(userId);
    user.contentType = contentType;
    user.available = available;
    user.lastSeenMessageId = lastSeenMessageId;
    user.selectedIds = [];
    user.queue = [];
    user.target = undefined;
    user.lastError = undefined;
    await this.save();
  }

  async appendLiveItems(
    userId: number,
    items: QueueItem[],
    lastSeenMessageId?: number,
  ): Promise<number> {
    const user = this.getUser(userId);
    const sourceKey = user.source ? String(user.source.chatId) : "";
    const sentKeys = new Set(user.sentItemKeys);
    const knownIds = new Set([
      ...user.available.map((item) => item.id),
      ...user.queue.map((item) => item.id),
    ]);
    let added = 0;

    for (const item of items) {
      user.lastSeenMessageId = Math.max(user.lastSeenMessageId ?? 0, item.messageId);
      if (knownIds.has(item.id)) continue;
      if (sentKeys.has(`${sourceKey}:${item.messageId}`)) {
        user.duplicateCount += 1;
        knownIds.add(item.id);
        continue;
      }

      const queuedItem = { ...item, status: "pending" as const, error: undefined };
      user.available.push(queuedItem);
      user.queue.push(queuedItem);
      knownIds.add(item.id);
      added += 1;
    }

    if (lastSeenMessageId !== undefined) {
      user.lastSeenMessageId = Math.max(user.lastSeenMessageId ?? 0, lastSeenMessageId);
    }
    if (user.available.length > 25_000) {
      user.available.splice(0, user.available.length - 25_000);
    }
    await this.save();
    return added;
  }

  async setSelection(userId: number, selectedIds: string[]) {
    this.getUser(userId).selectedIds = selectedIds;
    await this.save();
  }

  async createQueue(userId: number) {
    const user = this.getUser(userId);
    const selected = new Set(user.selectedIds);
    const sentKeys = new Set(user.sentItemKeys);
    const sourceKey = user.source ? String(user.source.chatId) : "";
    const selectedItems = user.available
      .filter((item) => selected.has(item.id));
    user.duplicateCount += selectedItems.filter((item) =>
      sentKeys.has(`${sourceKey}:${item.messageId}`),
    ).length;
    user.queue = selectedItems
      .filter((item) => !sentKeys.has(`${sourceKey}:${item.messageId}`))
      .map((item) => ({ ...item, status: "pending", error: undefined }));
    await this.save();
  }

  async markItemSent(userId: number, item: QueueItem) {
    await this.markItemsSent(userId, [item]);
  }

  async markItemsSent(userId: number, items: QueueItem[]) {
    const user = this.getUser(userId);
    const sourceKey = user.source ? String(user.source.chatId) : "";
    const itemIds = new Set(items.map((item) => item.id));
    for (const queuedItem of user.queue) {
      if (itemIds.has(queuedItem.id)) {
        queuedItem.status = "completed";
        queuedItem.error = undefined;
      }
    }
    for (const item of items) {
      const key = `${sourceKey}:${item.messageId}`;
      if (!user.sentItemKeys.includes(key)) {
        user.sentItemKeys.push(key);
      }
    }
    if (user.sentItemKeys.length > 10_000) {
      user.sentItemKeys.splice(0, user.sentItemKeys.length - 10_000);
    }
    await this.save();
  }

  async skipNext(userId: number): Promise<QueueItem | undefined> {
    const user = this.getUser(userId);
    const index = user.queue.findIndex((item) => item.status === "pending");
    if (index < 0) return undefined;
    const [item] = user.queue.splice(index, 1);
    await this.save();
    return item;
  }

  async recordTransfer(userId: number, record: TransferHistory) {
    const user = this.getUser(userId);
    user.history.unshift(record);
    user.history = user.history.slice(0, 20);
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

  async recoverProcessing(userId: number) {
    const user = this.getUser(userId);
    let changed = false;
    for (const item of user.queue) {
      if (item.status === "processing") {
        item.status = "pending";
        item.error = undefined;
        changed = true;
      }
    }
    if (changed) await this.save();
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
    // Processing is an in-memory lock. Persist only the states needed for
    // recovery; completed items are persisted by markItemSent().
    if (status !== "processing" && status !== "completed") {
      await this.save();
    }
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
    user.scheduledAt = undefined;
    await this.save();
  }

  async reset(userId: number) {
    const current = this.getUser(userId);
    this.state.users[String(userId)] = {
      ...emptyUser(userId),
      authorized: current.authorized,
      liveMode: current.liveMode,
      language: current.language,
      notifyOnComplete: current.notifyOnComplete,
      transferSpeed: current.transferSpeed,
    };
    await this.save();
  }
}

function normalizeTransferSpeed(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.min(10, Math.max(0.1, Math.round(value * 10) / 10));
}