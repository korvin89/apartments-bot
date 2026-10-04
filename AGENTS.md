# AGENTS.md

A Telegram bot that posts new Belgrade apartment and house listings for sale to a couple's shared group chat. The owners talk to you in Russian; everything in the repo is English: code, comments, bot messages, docs, commit messages.

## Invariants

- **Unknown passes.** A `Listing` field a site doesn't publish is `null` (an unknown place is the slug `UNKNOWN_PLACE`), and every filter in `src/filters.ts` rejects only on data that is present. The owners' rule is "show more rather than less": new filters default to off and follow the same rule. One exception: with a place list set, an unknown place is rejected (the owners found ads without a location useless).
- **Place slugs are 4zida-style.** 4zida's own URL slugs are the reference; every other source converts its place names with `toPlaceSlug()` in `src/places.ts`. Place lists in `src/search.config.ts` are substrings checked against the catalog `src/data/places-4zida.json`; verify a new fragment there so it matches only what it should (`kosutnjak-cukarica`, because `kosutnjak` also hits Stari Košutnjak in Rakovica).
- **Overviews instead of floods.** Each listing gets at most one card, and only when it is genuinely new. On the first run, the first poll of a new source, and after a filter change, matching listings go into one overview instead (`formatDigest()`, collapsed blocks per municipality) and are marked as shown. Filter changes are tracked by a version number per source (`job:<source>:filters_version`), so a source that was down still notices the change. A change to `src/poll.ts` keeps this, or the chat floods with hundreds of old listings; `test/poll.test.ts` covers each case.
- **Filters set in the chat** are stored in the database (`meta` key `filters`) and override `src/search.config.ts`, which holds the defaults `/filters` → Reset returns to.
- **The database holds the owners' likes and filters.** Schema changes go through `ListingsDb.migrate()` in `src/db.ts`, written for existing databases.
- **Polite scraping:** sequential requests about a second apart; ad pages only for new listings that pass the filters.

Before changing a source in `src/sources/` or diagnosing a site that fails, read [docs/sources.md](docs/sources.md): it records each site's access path and traps (DataDome, Cloudflare and curl-impersonate, the 4zida new-build URL).

## Verifying

- `pnpm test` and `pnpm typecheck` green.
- Parsers are tested on real captured responses in `test/fixtures/` (gzipped). When a site changes, add a fresh capture and fix the parser against it.
- Bot behaviour is tested through a fake Telegram API (`harness()` in `test/bot.test.ts`); extend it for new buttons and commands.
- `pnpm preview` hits the live sites read-only and shows what each source returns.
- Card layout is judged by the owners in Telegram: show them the rendered text of `formatCard()` for a sample listing.
