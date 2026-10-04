import { Bot, GrammyError, InlineKeyboard, type CommandContext, type Context } from 'grammy';
import type { ListingsDb } from './db.js';
import { esc, fmtWhen, formatCard, formatDigest, formatShort, statusLabel } from './format.js';
import { rejectReason } from './filters.js';
import { loadSearchConfig } from './settings.js';
import { SOURCE_STATS_KEY } from './poll.js';
import { HELP_TEXT } from './help.js';
import type { ListingEvent, ListingStatus, StoredListing } from './types.js';
import { log, logError, warn } from './config.js';
import { registerFilters } from './filters-ui.js';

export interface Notifier {
  /** Sends a listing card, returns the message id when available. */
  send(ev: ListingEvent): Promise<number | null>;
  /** Posts a service message (HTML): a health warning or a listings overview. */
  alert(html: string): Promise<void>;
}

export class ConsoleNotifier implements Notifier {
  async send(ev: ListingEvent): Promise<number | null> {
    const text = formatCard(ev).replace(/<[^>]+>/g, '');
    console.log('\n' + text + '\n');
    return null;
  }

  async alert(html: string): Promise<void> {
    console.log('\n' + html.replace(/<[^>]+>/g, '') + '\n');
  }
}

export function keyboardFor(l: StoredListing): InlineKeyboard {
  return new InlineKeyboard()
    .text(l.status === 'liked' ? '👍 Liked ✓' : '👍 Like', `st:${l.id}:liked`)
    .text('👎 Dislike', `st:${l.id}:disliked`);
}

/** Cards sent before the rename carry old callback values. */
const LEGACY_ACTION: Record<string, ListingStatus> = {
  starred: 'liked',
  contacted: 'liked',
  hidden: 'disliked',
};

/** /overview lists listings seen on a site this recently, i.e. probably still for sale. */
const OVERVIEW_WINDOW_MS = 3 * 86_400_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The group the bot posts to. Telegram gives a group a new id when it becomes a
 * supergroup (this happens on its own, e.g. after some settings change). The new id
 * is remembered in the database, tied to the configured one, so a different
 * TELEGRAM_CHAT_ID in .env is never overridden by a stale migration.
 */
export class ChatTarget {
  constructor(
    private readonly db: ListingsDb,
    private readonly configured: string,
  ) {}

  get id(): string {
    const raw = this.db.getMeta('chat_migration');
    if (raw) {
      const m = JSON.parse(raw) as { from: string; to: string };
      if (m.from === this.configured) return m.to;
    }
    return this.configured;
  }

  get isSet(): boolean {
    return this.configured !== '';
  }

  migrate(to: string): void {
    if (to === this.id) return;
    warn(`Group ${this.id} was upgraded to supergroup ${to}; posting there from now on. Update TELEGRAM_CHAT_ID in .env to ${to}.`);
    this.db.setMeta('chat_migration', JSON.stringify({ from: this.configured, to }));
  }
}

/** The supergroup id Telegram reports when a call hits a group that was upgraded. */
function migratedTo(e: unknown): string | null {
  return e instanceof GrammyError && e.parameters.migrate_to_chat_id ? String(e.parameters.migrate_to_chat_id) : null;
}

export class TelegramNotifier implements Notifier {
  constructor(
    private readonly bot: Bot,
    private readonly chat: ChatTarget,
  ) {}

  async alert(html: string): Promise<void> {
    const post = () =>
      this.bot.api.sendMessage(this.chat.id, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    try {
      await post();
    } catch (e) {
      const to = migratedTo(e);
      if (!to) throw e;
      this.chat.migrate(to);
      await post();
    }
  }

  async send(ev: ListingEvent): Promise<number | null> {
    const caption = formatCard(ev);
    const reply_markup = keyboardFor(ev.listing);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (ev.listing.imageUrl) {
          try {
            const msg = await this.bot.api.sendPhoto(this.chat.id, ev.listing.imageUrl, {
              caption,
              parse_mode: 'HTML',
              reply_markup,
            });
            return msg.message_id;
          } catch (e) {
            if ((e instanceof GrammyError && e.error_code === 429) || migratedTo(e)) throw e;
            warn(`sendPhoto failed, falling back to text: ${(e as Error).message}`);
          }
        }
        const msg = await this.bot.api.sendMessage(this.chat.id, caption, {
          parse_mode: 'HTML',
          reply_markup,
          link_preview_options: { is_disabled: true },
        });
        return msg.message_id;
      } catch (e) {
        const to = migratedTo(e);
        if (to) {
          this.chat.migrate(to);
          continue;
        }
        if (e instanceof GrammyError && e.error_code === 429) {
          const wait = (e.parameters.retry_after ?? 5) * 1000;
          warn(`Telegram 429, waiting ${wait} ms`);
          await sleep(wait);
          continue;
        }
        throw e;
      }
    }
    // Out of retries: fail loudly so the poll queues the card for the next poll
    throw new Error(`Telegram kept refusing the card for ${ev.listing.url}`);
  }
}

/** Shown in the Telegram command menu; registered on startup. */
export const BOT_COMMANDS = [
  { command: 'filters', description: 'View and change search filters' },
  { command: 'overview', description: 'Re-send the overview of listings without a card' },
  { command: 'liked', description: 'Listings we liked' },
  { command: 'disliked', description: 'Listings we disliked' },
  { command: 'poll', description: 'Check the sites now' },
  { command: 'status', description: 'Bot health and counts' },
  { command: 'help', description: 'What this bot does' },
];


/** "4zida:prodaja-stanova/beograd" -> "4zida apartments" */
function sourceLabel(name: string): string {
  return name.replace(':prodaja-stanova/beograd', ' apartments').replace(':prodaja-kuca/beograd', ' houses');
}

/** Deletes every card posted about a listing, except `skip` (already deleted). Best effort. */
async function deleteCards(api: Bot['api'], chatId: string, l: StoredListing, skip?: number): Promise<void> {
  const ids = [l.tgMessageId, ...l.extraMessageIds].filter((m): m is number => m !== null && m !== skip);
  for (const m of ids) await api.deleteMessage(chatId, m).catch((e) => warn(`delete card ${m}: ${(e as Error).message}`));
}

export function statusText(db: ListingsDb): string {
  const c = db.counts();
  const lastIso = db.getMeta('last_poll_at');
  const stats = JSON.parse(db.getMeta(SOURCE_STATS_KEY) ?? '[]') as { name: string; checked: number; error: string | null }[];
  const sites = stats.map((s) => {
    const fails = Number(db.getMeta(`health:${s.name}:fails`) ?? 0);
    const failing = fails > 1 ? ` (${fails} polls in a row)` : '';
    if (s.error) {
      const why = /HTTP \d{3}|DataDome|Cloudflare|timed? ?out|ENOTFOUND|ECONNRESET/i.exec(s.error)?.[0] ?? 'see the log';
      return `⚠️ ${esc(sourceLabel(s.name))}: ${esc(why)}${failing}`;
    }
    if (s.checked === 0) return `⚠️ ${esc(sourceLabel(s.name))}: returned nothing${failing}`;
    return `✅ ${esc(sourceLabel(s.name))}: checked ${s.checked}`;
  });
  return [
    `📊 <b>Status</b>`,
    `Sent to chat: ${db.countNotified()} · 👍 ${c.liked ?? 0} · 👎 ${c.disliked ?? 0}`,
    `Last poll: ${lastIso ? fmtWhen(lastIso) : 'never'}`,
    '',
    sites.length ? `<b>Sites in the last poll</b>\n${sites.join('\n')}` : 'Per-site results appear after the next poll.',
  ].join('\n');
}

export interface BotDeps {
  db: ListingsDb;
  chat: ChatTarget;
  triggerPoll: () => Promise<string>;
}

export function createBot(token: string, deps: BotDeps): Bot {
  const bot = new Bot(token);

  // Only respond in the configured chat, if one is set
  bot.use(async (ctx, next) => {
    // Telegram's service messages about a group becoming a supergroup
    const m = ctx.message;
    if (m?.migrate_to_chat_id && String(ctx.chat?.id) === deps.chat.id) deps.chat.migrate(String(m.migrate_to_chat_id));
    if (m?.migrate_from_chat_id && String(m.migrate_from_chat_id) === deps.chat.id && ctx.chat) deps.chat.migrate(String(ctx.chat.id));
    if (deps.chat.isSet && ctx.chat && String(ctx.chat.id) !== deps.chat.id) {
      if (ctx.message?.text?.startsWith('/start')) {
        await ctx.reply(`This chat is not configured. chat id: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }
    await next();
  });

  bot.command('help', (ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }));
  bot.command('start', (ctx) =>
    ctx.reply(`${HELP_TEXT}\n\nchat id of this chat: <code>${ctx.chat.id}</code>`, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }),
  );

  bot.command('status', (ctx) => ctx.reply(statusText(deps.db), { parse_mode: 'HTML' }));

  bot.command('poll', async (ctx) => {
    await ctx.reply('Checking the sites…');
    // Not awaited: updates are handled one at a time, and a poll takes a while.
    // Buttons and commands keep working meanwhile.
    void deps
      .triggerPoll()
      .then((summary) => ctx.reply(summary))
      .catch((e) => warn(`/poll reply: ${(e as Error).message}`));
  });

  const listCmd = (status: ListingStatus, empty: string) => async (ctx: CommandContext<Context>) => {
    const items = deps.db.listByStatus(status, 30);
    if (items.length === 0) return ctx.reply(empty);
    await ctx.reply(items.map((l, i) => `${i + 1}. ${formatShort(l)}`).join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  };
  // /liked: one message, each item with its own Unlike / Dislike buttons, edited in place.
  const LIKED_LIMIT = 30;
  const likedView = () => {
    const items = deps.db.listByStatus('liked', LIKED_LIMIT);
    if (items.length === 0) return { text: 'Nothing liked yet. Press 👍 under a card.', keyboard: undefined };
    const keyboard = new InlineKeyboard();
    items.forEach((l, i) => {
      if (i > 0) keyboard.row();
      keyboard.text(`${i + 1}. ↩️ Unlike`, `lk:${l.id}:unlike`).text(`${i + 1}. 👎 Dislike`, `lk:${l.id}:dislike`);
    });
    const text =
      `👍 <b>Liked (${items.length})</b>\n\n` +
      items.map((l, i) => `${i + 1}. ${formatShort(l)}`).join('\n') +
      '\n\n<i>Unlike: back to unrated, price drops still notify. Dislike: never show again.</i>';
    return { text, keyboard };
  };

  bot.command('liked', (ctx) => {
    const v = likedView();
    return ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard, link_preview_options: { is_disabled: true } });
  });

  bot.callbackQuery(/^lk:(\d+):(unlike|dislike)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const action = ctx.match[2];
    const l = deps.db.get(id);
    if (!l) return ctx.answerCallbackQuery('Listing not found');
    // The list may be stale: someone may have disliked the listing from its card meanwhile.
    // Unlike only undoes a like; it never un-mutes a disliked listing.
    if (action === 'unlike' && l.status !== 'liked') {
      const v = likedView();
      await ctx.editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard, link_preview_options: { is_disabled: true } }).catch(() => {});
      return ctx.answerCallbackQuery('Not liked anymore, list refreshed');
    }
    const next: ListingStatus = action === 'unlike' ? 'new' : 'disliked';
    deps.db.setStatus(id, next);
    log(`${ctx.from.first_name} ${action}d ${l.url} from /liked`);

    // Keep the cards in the chat in sync: refresh the buttons, or remove every card on dislike.
    if (deps.chat.isSet) {
      if (next === 'disliked') await deleteCards(ctx.api, deps.chat.id, l);
      else if (l.tgMessageId) {
        await ctx.api
          .editMessageReplyMarkup(deps.chat.id, l.tgMessageId, { reply_markup: keyboardFor({ ...l, status: next }) })
          .catch((e) => warn(`sync original card: ${(e as Error).message}`));
      }
    }

    const v = likedView();
    await ctx
      .editMessageText(v.text, { parse_mode: 'HTML', reply_markup: v.keyboard, link_preview_options: { is_disabled: true } })
      .catch((e) => warn(`refresh liked list: ${(e as Error).message}`));
    await ctx.answerCallbackQuery(`${next === 'new' ? '↩️ Unliked' : '👎 Disliked'}: ${l.title} (${ctx.from.first_name})`);
  });
  bot.command('disliked', listCmd('disliked', 'Nothing disliked yet.'));

  bot.callbackQuery(/^st:(\d+):(liked|disliked|starred|hidden|contacted)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const target = LEGACY_ACTION[ctx.match[2]] ?? (ctx.match[2] as ListingStatus);
    const l = deps.db.get(id);
    if (!l) return ctx.answerCallbackQuery('Listing not found');
    const who = ctx.from.first_name;

    // Dislike removes the card from the chat for good; /disliked still lists it.
    if (target === 'disliked') {
      deps.db.setStatus(id, 'disliked');
      log(`${who} disliked ${l.url}`);
      try {
        await ctx.deleteMessage();
        // The listing may have more cards (the original and price drops): remove them too
        const pressed = ctx.callbackQuery.message?.message_id;
        if (deps.chat.isSet) await deleteCards(ctx.api, deps.chat.id, l, pressed);
        await ctx.answerCallbackQuery(`👎 Disliked (${who})`);
      } catch (e) {
        // Bots can only delete their own messages younger than 48h unless they are group admins.
        warn(`deleteMessage: ${(e as Error).message}`);
        await ctx.editMessageReplyMarkup({ reply_markup: keyboardFor({ ...l, status: 'disliked' }) }).catch(() => {});
        await ctx.answerCallbackQuery({
          text: 'Disliked, but Telegram would not let me delete this message. Make the bot a group admin with "Delete messages".',
          show_alert: true,
        });
      }
      return;
    }

    const next: ListingStatus = l.status === target ? 'new' : target;
    deps.db.setStatus(id, next);
    log(`${who} set ${next === 'new' ? 'unrated' : next} on ${l.url}`);
    const updated = { ...l, status: next };
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: keyboardFor(updated) });
    } catch (e) {
      warn(`editMessageReplyMarkup: ${(e as Error).message}`);
    }
    await ctx.answerCallbackQuery(next === 'new' ? 'Cleared' : `${statusLabel(next)} (${who})`);
  });

  // /c<id> from an overview line: post that listing's card with Like / Dislike
  bot.hears(/^\/c(\d+)(?:@\w+)?$/, async (ctx) => {
    const l = deps.db.get(Number(ctx.match[1]));
    if (!l) return ctx.reply('Listing not found.');
    const target = deps.chat.isSet ? deps.chat : new ChatTarget(deps.db, String(ctx.chat.id));
    const msgId = await new TelegramNotifier(bot, target).send({ kind: 'new', listing: l });
    if (msgId) deps.db.attachCard(l.id, msgId);
    // Keep the chat clean; needs the bot to be a group admin with "Delete messages"
    await ctx.deleteMessage().catch((e) => warn(`delete /c command: ${(e as Error).message}`));
  });

  bot.command('overview', async (ctx) => {
    const cfg = loadSearchConfig(deps.db);
    const since = new Date(Date.now() - OVERVIEW_WINDOW_MS).toISOString();
    const items = deps.db.overviewOnly(since).filter((l) => !rejectReason(l, cfg));
    if (items.length === 0) return ctx.reply('Nothing to show: every matching listing already has a card or a rating.');
    const title = `📋 <b>Overview: ${items.length} listings</b> shown earlier without a card, not rated yet`;
    for (const html of formatDigest(title, items)) {
      await ctx.reply(html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      await sleep(1000);
    }
  });

  // Last: it adds a catch-all text handler for filter prompts
  registerFilters(bot, deps.db);

  bot.catch((err) => logError(`Bot error handling update ${err.ctx.update.update_id}`, err.error));
  return bot;
}
