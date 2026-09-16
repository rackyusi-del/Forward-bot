---
name: Telegram Bot API limits
description: Constraints that shape the personal forwarding bot architecture.
---

The Bot API can process new updates delivered after the bot has access to a chat, but it cannot enumerate a chat's complete historical message list. A specific message URL can be copied when the bot has permission.

**Why:** A Bot API-only implementation cannot provide full historical backfill or read sources accessible only to a personal account.

**How to apply:** Keep the simple Railway version Bot API-only and document live-forwarding behavior; use an MTProto user-account worker only when historical backfill or personal-account-only sources are required.