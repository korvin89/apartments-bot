# apartments-bot

A Telegram bot that watches Belgrade real-estate sites for apartments and houses for sale and posts new matches to a group chat.

- **Sources:** 4zida.rs, nekretnine.rs, halooglasi.com, cityexpert.rs. How each one is scraped and how it breaks: [docs/sources.md](docs/sources.md).
- **Cards:** photo, price, €/m², area, rooms, floor, registration, mortgage, elevator, heating, place, link. Price drops on known listings get their own card.
- **Buttons:** 👍 Like keeps a listing in `/liked`. 👎 Dislike deletes the card and mutes it for good.
- **Filters** are edited from the chat with `/filters` and stored in the database. A listing that lacks a detail is never filtered out by that detail.
- **Duplicates** across sites are collapsed when type, rooms, area, rounded price and place match.
- **Health alerts:** if a source fails or returns nothing for 3 polls in a row, the bot posts a warning, and again when it recovers.

Commands: `/help`, `/filters`, `/liked`, `/disliked`, `/poll`, `/status`. `/help` in the chat explains them; the command menu is registered on startup.

## Local setup

Requires Node 22+ and pnpm (`corepack enable` picks the pinned version).

```bash
pnpm install
scripts/install-curl-impersonate.sh   # needed for halooglasi.com only
cp .env.example .env                  # fill in TELEGRAM_BOT_TOKEN
pnpm preview                          # what each site returns now; no Telegram, no writes
pnpm start                            # bot + polling
```

Telegram setup:

1. Create a bot with @BotFather and put the token in `.env`.
2. In BotFather, turn **Group Privacy off** for the bot, otherwise it can't see commands in the group.
3. Add the bot to your group and send `/start`. It replies with the chat id (negative, like `-100…`). Put it in `TELEGRAM_CHAT_ID` and restart. Until then the bot only answers `/start` and doesn't poll, so the welcome isn't wasted.
4. Optional: make the bot a group admin with "Delete messages", so Dislike can remove cards older than 48 hours.

The first run doesn't post a card per listing. It posts the `/help` text, then one overview of everything that matches right now, grouped by municipality in collapsed blocks, and new listings arrive as cards after that. The same happens when a source is added or filters widen. `NOTIFY_ON_FIRST_RUN=true` switches the first run to full cards.

## Configuration

`.env` (see [.env.example](.env.example)):

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | | Bot token. Required. |
| `TELEGRAM_CHAT_ID` | | The group to post to. The bot ignores other chats, and doesn't poll the sites until this is set. |
| `POLL_INTERVAL_MINUTES` | `10` | How often to check the sites. |
| `DB_PATH` | `./data/listings.db` | SQLite database: listings, likes, chat filters. |
| `NOTIFY_ON_FIRST_RUN` | `false` | Post a card per listing on the very first run instead of one overview. |
| `HEALTH_ALERT_AFTER` | `3` | Failed polls in a row before a warning. |
| `CURL_IMPERSONATE` | `./bin/curl-impersonate` | Binary for halooglasi.com. If missing, that source is skipped. |
| `LOG_DIR` | `./logs` | Daily log files `bot-YYYY-MM-DD.log`. |
| `LOG_RETENTION_DAYS` | `14` | Older log files are deleted. |

[src/search.config.ts](src/search.config.ts) holds the default filters (what `/filters` → Reset returns to), the place lists derived from our map, which sources are on, and pages per poll.

## Development

```bash
pnpm test        # parsers on captured pages, filter rules, poll cycle, bot buttons
pnpm typecheck
pnpm poll        # one poll cycle on a temporary copy of the database, messages printed to the console
```

Tests use captured site responses in `test/fixtures/` and a fake Telegram API, so they need no network and no token. When a site changes its layout, save a fresh capture next to the old one (gzipped) and update the parser until the tests pass.

```
src/
  index.ts          entry point: bot + scheduler
  cli.ts            pnpm preview / pnpm poll
  poll.ts           one cycle: sources → db → cards and overviews, retries, health
  sources/          one module per site; index.ts registers them
  places.ts         site place names → 4zida-style slugs (catalog in src/data/)
  filters.ts        filter rules
  settings.ts       chat-editable filters stored in the db, input parsing
  filters-ui.ts     /filters panel
  telegram.ts       bot, cards, buttons, commands
  format.ts         card text
  db.ts             SQLite schema and migrations
  health.ts         failure tracking and alerts
  logger.ts         console + daily log files
docs/sources.md     per-site scraping notes
deploy/             systemd unit
scripts/            curl-impersonate installer
test/               tests and fixtures
```

## Deploying to Ubuntu

Target: Ubuntu 24.04, 1 vCPU, 1 GB RAM (not yet run there end to end). The bot uses about 160 MB of memory, a second of CPU per poll and about 8 GB of traffic a month.

1. **Node 22 from NodeSource** (systemd needs `node` in `/usr/bin`, which nvm doesn't provide):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   sudo corepack enable
   ```
2. **Code and dependencies:**
   ```bash
   git clone <repo-url> ~/apartments-bot && cd ~/apartments-bot
   pnpm install --frozen-lockfile
   scripts/install-curl-impersonate.sh
   ```
3. **Settings:** create `.env` (copy it from your machine or fill in from `.env.example`).
4. **Database (optional).** Without it the server starts fresh from the defaults in `src/search.config.ts`. To keep likes and chat filters, stop the local bot and copy the whole `data/` folder, including the `-wal` and `-shm` files next to the database:
   ```bash
   scp -r data/ <server>:~/apartments-bot/
   ```
5. **Check the sites are reachable from the server:**
   ```bash
   pnpm preview
   ```
   Every source should report listings. halooglasi (Cloudflare) and nekretnine (DataDome) can be stricter with datacenter IPs; if one is blocked, the bot keeps working without it and warns in the chat.
6. **Run as a service.** Check `User` and `WorkingDirectory` in `deploy/apartments-bot.service`, then:
   ```bash
   sudo cp deploy/apartments-bot.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now apartments-bot
   ```

**Only one copy of the bot may run per token.** Telegram delivers updates to one process; a second one gets "409 Conflict". Stop the local bot before starting the server one.

Operating it:

```bash
sudo systemctl status apartments-bot        # is it running
journalctl -u apartments-bot -f             # live output
tail -f logs/bot-$(date -u +%F).log         # the bot's own log (UTC times)
grep -E "WARN|ERROR" logs/*.log             # problems only
```

Updating:

```bash
cd ~/apartments-bot && git pull && pnpm install --frozen-lockfile && sudo systemctl restart apartments-bot
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Bot doesn't react to commands in the group | Group Privacy is on in BotFather, or `TELEGRAM_CHAT_ID` is wrong. |
| "group chat was upgraded to a supergroup" in the log | Telegram gave the group a new id. The bot switches to it by itself and logs the new id; put that id in `TELEGRAM_CHAT_ID`. |
| A card or overview failed to send | It is retried on the next poll. |
| "Stopped receiving Telegram updates" in the log | Another copy runs with the same token (409) or the token was revoked (401). The bot posts a warning and exits; systemd restarts it. |
| `409 Conflict` in the log | Another copy of the bot is running with the same token. |
| "halooglasi skipped: curl-impersonate not found" | Run `scripts/install-curl-impersonate.sh`. |
| halooglasi or nekretnine fail with 403 | Bot protection blocked the server IP. See [docs/sources.md](docs/sources.md). |
| A source "returned 0 listings" | The site changed its layout; the parser needs an update. |
| Dislike doesn't delete old cards | The bot needs admin rights with "Delete messages" for cards older than 48 hours. |
