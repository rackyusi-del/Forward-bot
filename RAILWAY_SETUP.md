# Personal Telegram Forwarding Bot — Railway Setup

This is a single-owner Telegram **Bot API** service. It does not log in to a personal Telegram account and does not need `API_ID`, `API_HASH`, OTP, 2FA, Redis, or a database.

## 1. Create the bot

1. Open `@BotFather`.
2. Run `/newbot` and copy the token.
3. Run `/setprivacy`, choose the bot, and select **Disable**. This is required so `.sendhere` can be read when it is sent as a normal group message.

Keep the token private. Do not put it in this repository or send it in chat.

## 2. Deploy to Railway

1. Create a Railway project and deploy this repository.
2. Railway will use `railway.json` and the included `Dockerfile`.
3. Add these Variables to the service:

```env
BOT_TOKEN=your_BotFather_token
OWNER_TELEGRAM_ID=your_numeric_telegram_id
DATA_DIR=/data
NODE_ENV=production
LOG_LEVEL=info
```

4. Add a Railway Volume and mount it at `/data`.
5. Redeploy the service.

The volume keeps the forwarding configuration, message deduplication keys, and polling checkpoint after restarts.

## 3. Find your numeric Telegram ID

Before setting `OWNER_TELEGRAM_ID`, message the bot with:

```text
/myid
```

Add the returned number to Railway Variables and redeploy. Until it is set, the bot will not accept control commands.

## 4. Telegram permissions

For a source group or channel:

- Add the bot to the source.
- Give it permission to read messages. A channel normally requires the bot to be an administrator.
- For groups, privacy mode must be disabled.

For a target group:

- Add the bot.
- Give it permission to send messages.
- For forum topics, add it to the target supergroup and send `.sendhere` inside the exact topic.

## 5. Use the bot

1. Open the bot privately.
2. Send a source URL such as `https://t.me/examplechannel`.
3. Select a content type.
4. Send `.sendhere` inside the target group or exact forum topic.
5. The bot will copy new eligible messages it receives.
6. Send `.stop` to stop the active job.

Useful commands:

- `/start` or `/help`
- `/status`
- `/reset`
- `.stop`

## Important Bot API limitation

The Bot API does not provide a general history-download API. Therefore this bot cannot scan all old messages in a group/channel. It can:

- Process new messages received after the bot is added and the job is started.
- Copy one specific message when the source URL contains a message ID, such as `https://t.me/examplechannel/123`.

It cannot bypass protected content, private-chat permissions, Telegram rate limits, or missing bot permissions. If full historical backfill or reading sources that only your personal account can access is required, the project must use an MTProto user-account worker instead of Bot API-only mode.