# Personal Telegram Forwarding Bot

A Railway-ready, single-owner Telegram Bot API service that copies eligible new messages from an accessible source chat into a selected target group or forum topic.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server and Telegram polling listener
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required production env: `BOT_TOKEN`, `OWNER_TELEGRAM_ID`, and persistent `DATA_DIR` (Railway should mount `/data`)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

- Owner-only bot control with source URL selection, content filters, `.sendhere`, forum-topic targeting, `.stop`, status, reset, retries, and duplicate protection.
- Uses Telegram Bot API polling so it runs as one persistent Railway service.
- Stores only non-secret job state and checkpoints in an atomic JSON file on the mounted data directory.
- Bot API cannot read historical chat history; historical backfill requires the separate MTProto architecture documented in `RAILWAY_SETUP.md`.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Never commit or log `BOT_TOKEN`.
- Only one Railway replica should run for a polling bot; two replicas cause Telegram polling conflicts.
- A Railway Volume mounted at `/data` is required for restart-safe state.
- Bot privacy must be disabled to receive `.sendhere` as ordinary group text.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
