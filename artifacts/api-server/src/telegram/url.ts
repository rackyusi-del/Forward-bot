import type { SourceConfig } from "./state";

export function parseTelegramSourceUrl(value: string): SourceConfig | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return undefined;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "t.me" && hostname !== "telegram.me") {
    return undefined;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length === 0 || parts[0] === "joinchat" || parts[0].startsWith("+")) {
    return undefined;
  }

  if (parts[0] === "c" && /^\d+$/.test(parts[1] ?? "")) {
    const internalId = parts[1];
    const messageId = lastNumericPart(parts.slice(2));
    return {
      chatId: Number(`-100${internalId}`),
      label: `private chat ${internalId}`,
      ...(messageId === undefined ? {} : { specificMessageId: messageId }),
    };
  }

  const username = parts[0];
  if (!/^[A-Za-z0-9_]{5,}$/.test(username) || username === "s") {
    return undefined;
  }

  const messageId = lastNumericPart(parts.slice(1));
  return {
    chatId: `@${username}`,
    label: `@${username}`,
    ...(messageId === undefined ? {} : { specificMessageId: messageId }),
  };
}

function lastNumericPart(parts: string[]): number | undefined {
  const candidate = parts.at(-1);
  if (candidate === undefined || !/^\d+$/.test(candidate)) {
    return undefined;
  }
  const value = Number(candidate);
  return Number.isSafeInteger(value) ? value : undefined;
}