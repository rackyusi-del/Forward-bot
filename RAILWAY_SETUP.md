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
TRANSFER_ITEM_TIMEOUT_MS=0
MAX_TRANSFER_WORKERS=2
MAX_UPLOAD_WORKERS=8
TRANSFER_BATCH_SIZE=10
LIVE_POLL_INTERVAL_MS=15000
TRANSFER_STALL_TIMEOUT_MS=3600000
NODE_ENV=production
LOG_LEVEL=info
```

`API_ID` and `API_HASH` are read from Railway at runtime and are never
hardcoded. `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are accepted as backwards
compatible aliases, but the existing `API_ID` and `API_HASH` values should be
kept unchanged.

`TRANSFER_ITEM_TIMEOUT_MS=0` is intentional: large uploads are not failed just
because they take longer than a fixed number of minutes. A timed-out request
cannot be safely retried because Telegram may already have accepted it, so the
bot does not automatically retry a request whose delivery result is unknown.
The queue checkpoints each item immediately after Telegram confirms it.
`TRANSFER_STALL_TIMEOUT_MS` is a separate safety watchdog. It tracks worker
progress and never disconnects a healthy long-running Telegram upload. If no
worker progress is detected while no Telegram operation is in flight, the queue
is checkpointed and resumed by the supervisor.

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
11. Use `/stop` to pause, `/on` only as an emergency manual resume, `/cancel`,
    `/reset` and `/logout` as needed.
12. Live source monitoring is opt-in. Use `/live on` to watch for new matching
    files, or `/live off` to stop the watcher.
13. If Telegram reports an uncertain delivery, verify that item before using
    `/retry_uncertain`; uncertain items are never resent automatically.

The queue is persisted after every item state transition. Completed items are
never selected again. A restart resumes pending work automatically, while
interrupted deliveries are marked uncertain instead of being blindly duplicated.