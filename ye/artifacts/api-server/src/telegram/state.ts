import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../lib/logger";
import type { TelegramChat, TelegramMessage } from "./types";

export type ContentFilter =
  | "files"
  | "photos"
  | "videos"
  | "messages"
  | "links"
  | "everything";

export interface SourceConfig {
  chatId: number | string;
  label: string;
  specificMessageId?: number;
}

export interface TargetConfig {
  chatId: number;
  title?: string;
  threadId?: number;
}

export interface ForwardState {
  source?: SourceConfig;
  filter?: ContentFilter;
  target?: TargetConfig;
  active: boolean;
  processedKeys: string[];
  offset: number;
  lastError?: string;
  updatedAt: string;
}

const emptyState = (): ForwardState => ({
  active: false,
  processedKeys: [],
  offset: 0,
  updatedAt: new Date().toISOString(),
});

export class StateStore {
  private readonly statePath: string;
  private state: ForwardState = emptyState();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDirectory = process.env.DATA_DIR ?? "./data") {
    this.statePath = path.join(dataDirectory, "forwarder-state.json");
  }

  async load(): Promise<ForwardState> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ForwardState>;
      this.state = {
        ...emptyState(),
        ...parsed,
        processedKeys: Array.isArray(parsed.processedKeys)
          ? parsed.processedKeys.slice(-10_000)
          : [],
      };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code !== "ENOENT") {
        logger.warn({ err: error }, "Could not read saved bot state; starting fresh");
      }
    }
    return this.state;
  }

  get current(): ForwardState {
    return this.state;
  }

  hasProcessed(key: string): boolean {
    return this.state.processedKeys.includes(key);
  }

  async markProcessed(key: string): Promise<void> {
    if (!this.hasProcessed(key)) {
      this.state.processedKeys = [...this.state.processedKeys, key].slice(-10_000);
    }
    await this.save();
  }

  async save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
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

  async setSource(source: SourceConfig): Promise<void> {
    this.state.source = source;
    this.state.target = undefined;
    this.state.active = false;
    this.state.lastError = undefined;
    await this.save();
  }

  async setFilter(filter: ContentFilter): Promise<void> {
    this.state.filter = filter;
    this.state.target = undefined;
    this.state.active = false;
    this.state.lastError = undefined;
    await this.save();
  }

  async setTarget(target: TargetConfig): Promise<void> {
    this.state.target = target;
    this.state.lastError = undefined;
    await this.save();
  }

  async setActive(active: boolean): Promise<void> {
    this.state.active = active;
    await this.save();
  }

  async setOffset(offset: number): Promise<void> {
    this.state.offset = offset;
    await this.save();
  }

  async setError(errorMessage: string | undefined): Promise<void> {
    this.state.lastError = errorMessage;
    await this.save();
  }

  async reset(): Promise<void> {
    this.state = emptyState();
    await this.save();
  }
}

export function getMessageChat(message: TelegramMessage): TelegramChat {
  return message.chat;
}