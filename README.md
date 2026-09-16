# Personal Telegram Forwarding Bot

Railway-ready, single-owner Telegram Bot API service.

Start with [RAILWAY_SETUP.md](./RAILWAY_SETUP.md). The service uses polling, a persistent Railway Volume, owner-only controls, content filters, `.sendhere`, forum-topic targeting, retries, checkpoints, and duplicate protection.

This version intentionally does not use personal-account login. It can forward new messages the bot is allowed to receive and can copy a specific message URL. The Telegram Bot API cannot download a complete historical chat backlog.