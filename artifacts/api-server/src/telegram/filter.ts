import type { ContentFilter } from "./state";
import type { TelegramEntity, TelegramMessage } from "./types";

export function messageMatchesFilter(
  message: TelegramMessage,
  filter: ContentFilter,
): boolean {
  if (isControlMessage(message)) {
    return false;
  }

  if (filter === "everything") {
    return hasForwardableContent(message);
  }
  if (filter === "files") {
    return Boolean(message.document || message.audio || message.voice);
  }
  if (filter === "photos") {
    return Boolean(message.photo);
  }
  if (filter === "videos") {
    return Boolean(message.video || message.animation || message.video_note);
  }
  if (filter === "messages") {
    return Boolean(message.text);
  }
  return hasLink(message.text, message.entities) ||
    hasLink(message.caption, message.caption_entities);
}

export function isControlMessage(message: TelegramMessage): boolean {
  const text = (message.text ?? "").trim().toLowerCase();
  return text === ".sendhere" || text === ".stop" || text.startsWith("/");
}

function hasForwardableContent(message: TelegramMessage): boolean {
  return Boolean(
    message.text ||
      message.caption ||
      message.document ||
      message.photo ||
      message.video ||
      message.animation ||
      message.audio ||
      message.voice ||
      message.video_note ||
      message.sticker,
  );
}

function hasLink(text: string | undefined, entities: TelegramEntity[] | undefined): boolean {
  if (!text && !entities?.length) {
    return false;
  }
  if (entities?.some((entity) => entity.type === "url" || entity.type === "text_link")) {
    return true;
  }
  return Boolean(text && /https?:\/\/\S+/i.test(text));
}