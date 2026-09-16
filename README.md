# Personal Telegram Transfer Bot

Railway-ready Telegram transfer bot that uses the Bot API for commands and an
authorized Telegram user account for reading available source history and
sending selected content.

## Flow

1. `/login` in the bot's private chat
2. Send a source group/channel URL
3. Choose Files, Photos, Videos, Voice, Messages or Other Media
4. Select individual items or all items and create the queue
5. Send `.sendhere` in the destination group, channel or exact forum topic
6. Use `/transferspeed` to choose one of 10 slower speeds (0.1x–1x) or 10
   faster speeds (1x–10x)
7. Use `/queue`, `/status`, `/history`, `/stats` and `/logs` to monitor work
8. Use `/filter`, `/maxsize`, `/duplicates`, `/retry` and `/skip` to control work
9. Use `/schedule`, `/notify`, `/destination`, `/settings` and `/language`
10. Use `/stop` to pause, `/on` to continue from the saved queue, `/cancel`,
    `/reset` and `/logout` as needed

Each Telegram user has an isolated session, source, destination, queue and
checkpoint. Completed queue items are not selected again after restarts. Higher
transfer speeds use bounded parallel workers and a shorter inter-item delay;
slower speeds add a longer inter-item delay. Telegram flood-wait responses are
still respected.

The language menu supports English, Hindi, Spanish, French, German, Portuguese,
Arabic, Bengali, Russian and Chinese. User preferences, history, duplicate
tracking, filters and schedules are stored per Telegram user.

See [RAILWAY_SETUP.md](./RAILWAY_SETUP.md) for deployment and permissions.