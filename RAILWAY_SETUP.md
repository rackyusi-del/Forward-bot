# Forward Bot — Railway setup

This service uses the Telegram Bot API for commands and a Telegram MTProto user
session for reading history and sending as the account that completed `/login`.

## Variables

Set these in the Railway service:

```env
BOT_TOKEN=your_BotFather_token
API_ID=your_my_telegram_org_api_id
API_HASH=your_my_telegram_org_api_hash
DATA_DIR=/data
NODE_ENV=production
LOG_LEVEL=info
```

`API_ID` and `API_HASH` are read from Railway at runtime and are never
hardcoded. `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are accepted as backwards
compatible aliases, but the existing `API_ID` and `API_HASH` values should be
kept unchanged.

Attach a persistent Railway Volume mounted at `/data`. The bot writes:

- one `telegram-user-<telegram-id>.session` file per authorized user
- `forwarder-state.json` containing sources, queue item status, checkpoints,
  destination topic IDs and the Telegram polling offset

These files are written with restrictive permissions and are never included in
bot messages or logs. Do not commit the `/data` directory.

## Telegram permissions

The bot must be able to receive `/sendhere` in the destination chat. Add it to
the destination group/supergroup/channel and grant the permission needed to
send. For a forum topic, send `.sendhere` while inside that exact topic.

The personal account used with `/login` must already be able to access the
source chat. This implementation does not bypass protected content, private
chat permissions, Telegram rate limits, or sender identity restrictions.

## Use

1. Open the bot privately and send `/login`.
2. Enter the requested phone number, Telegram code and optional 2FA password.
   Input messages are deleted immediately after receipt and are not logged.
3. Send a source URL such as `https://t.me/examplechannel`.
4. Choose a content type and select specific history items or all items.
5. Press **Create queue**.
6. Send `/transferspeed` in the bot's private chat and choose one of the 10
   slower or 10 faster speed buttons.
7. Send `.sendhere` in the destination chat or exact forum topic.
8. Use `/queue`, `/status`, `/history`, `/stats` and `/logs` to monitor the job.
9. Use `/filter`, `/maxsize`, `/duplicates`, `/retry` and `/skip` to control it.
10. Use `/schedule`, `/notify`, `/destination`, `/settings` and `/language`.
11. Use `/stop`, `/resume`, `/cancel`, `/reset` and `/logout` as needed.

The queue is persisted after every item state transition. Completed items are
never selected again; failed items are retried only when `/resume` is used.