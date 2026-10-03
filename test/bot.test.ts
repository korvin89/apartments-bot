import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from 'grammy';
import { ListingsDb } from '../src/db.ts';
import { ChatTarget, createBot, statusText } from '../src/telegram.ts';
import { loadSearchConfig } from '../src/settings.ts';
import { searchConfig } from '../src/search.config.ts';
import { baseListing } from './helpers.ts';

const CHAT = -100500;
const chat = { id: CHAT, type: 'supergroup', title: 'Homes' };
const from = { id: 7, is_bot: false, first_name: 'Anna' };

interface Call { method: string; payload: Record<string, unknown> }

/**
 * A bot wired to a fake Telegram API: every API call is recorded and answered
 * with a plausible result, updates are fed in with handleUpdate.
 */
function harness(db: ListingsDb) {
  const bot: Bot = createBot('1:test', { db, chat: new ChatTarget(db, String(CHAT)), triggerPoll: async () => 'polled' });
  bot.botInfo = { id: 1, is_bot: true, first_name: 'bot', username: 'test_bot' } as Bot['botInfo'];
  const calls: Call[] = [];
  let nextId = 1000;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const p = payload as { message_id?: number; text?: string };
    const result = method.startsWith('send') || method === 'editMessageText'
      ? { message_id: p.message_id ?? ++nextId, date: 0, chat, text: p.text }
      : true;
    return { ok: true, result } as never;
  });
  let update = 1;
  return {
    calls,
    lastSentId: () => nextId,
    command: (text: string) =>
      bot.handleUpdate({ update_id: update++, message: { message_id: 1, date: 0, chat, from, text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } } as never),
    reply: (text: string, toMessageId: number) =>
      bot.handleUpdate({ update_id: update++, message: { message_id: 5000 + update, date: 0, chat, from, text, reply_to_message: { message_id: toMessageId, date: 0, chat } } } as never),
    press: (data: string, messageId = 1) =>
      bot.handleUpdate({ update_id: update++, callback_query: { id: String(update), from, chat_instance: 'x', data, message: { message_id: messageId, date: 0, chat, text: 'card' } } } as never),
    methods: () => calls.map((c) => c.method),
  };
}

describe('bot', () => {
  let db: ListingsDb;
  let id: number;

  beforeEach(() => {
    db = new ListingsDb(join(mkdtempSync(join(tmpdir(), 'bot-test-')), 'db.sqlite'));
    const stored = db.insert(baseListing, 'fp', new Date().toISOString());
    db.markNotified(stored.id, 777, new Date().toISOString());
    id = stored.id;
  });

  it('Like toggles and updates the buttons', async () => {
    const h = harness(db);
    await h.press(`st:${id}:liked`, 777);
    assert.equal(db.get(id)!.status, 'liked');
    assert.ok(h.methods().includes('editMessageReplyMarkup'));
    await h.press(`st:${id}:liked`, 777);
    assert.equal(db.get(id)!.status, 'new');
  });

  it('Dislike deletes the card', async () => {
    const h = harness(db);
    await h.press(`st:${id}:disliked`, 777);
    assert.equal(db.get(id)!.status, 'disliked');
    assert.ok(h.calls.some((c) => c.method === 'deleteMessage'));
  });

  it('old cards with legacy buttons still work', async () => {
    const h = harness(db);
    await h.press(`st:${id}:starred`, 777);
    assert.equal(db.get(id)!.status, 'liked');
  });

  it('/liked lists items and Unlike resets the original card', async () => {
    const h = harness(db);
    db.setStatus(id, 'liked');
    await h.command('/liked');
    const list = h.calls.find((c) => c.method === 'sendMessage')!;
    assert.match(String(list.payload.text), /Liked \(1\)/);
    await h.press(`lk:${id}:unlike`, h.lastSentId());
    assert.equal(db.get(id)!.status, 'new');
    const edit = h.calls.find((c) => c.method === 'editMessageReplyMarkup');
    assert.equal(edit?.payload.message_id, 777);
  });

  it('/filters: a reply to the prompt changes the filter', async () => {
    const h = harness(db);
    await h.command('/filters');
    const panel = h.lastSentId();
    await h.press('f:in:maxPrice', panel);
    const prompt = h.lastSentId();
    await h.reply('abc', prompt);
    assert.equal(loadSearchConfig(db).maxPrice, searchConfig.maxPrice, 'invalid input must not change the filter');
    await h.reply('180k', prompt);
    assert.equal(loadSearchConfig(db).maxPrice, 180_000);
  });

  it('ignores ordinary chat messages', async () => {
    const h = harness(db);
    const before = JSON.stringify(loadSearchConfig(db));
    await h.reply('hello there', 424242);
    assert.equal(JSON.stringify(loadSearchConfig(db)), before);
    assert.equal(h.calls.length, 0);
  });

  it('/help describes the commands', async () => {
    const h = harness(db);
    await h.command('/help');
    const text = String(h.calls[0].payload.text);
    for (const cmd of ['/filters', '/liked', '/disliked', '/poll', '/status']) assert.ok(text.includes(cmd), cmd);
  });
});

describe('group upgraded to a supergroup', () => {
  const OLD = '-111222333';
  const NEW = '-1009998887776';

  function migratingApi(db: ListingsDb) {
    const bot = createBot('1:test', { db, chat: new ChatTarget(db, OLD), triggerPoll: async () => '' });
    bot.botInfo = { id: 1, is_bot: true, first_name: 'bot', username: 'test_bot' } as Bot['botInfo'];
    const sentTo: string[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      const chatId = String((payload as { chat_id?: unknown }).chat_id);
      if (method.startsWith('send')) sentTo.push(chatId);
      if (chatId === OLD) {
        return { ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: Number(NEW) } } as never;
      }
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: Number(chatId), type: 'supergroup' } } } as never;
    });
    return { bot, sentTo };
  }

  it('switches to the new id and resends the card', async () => {
    const db = new ListingsDb(join(mkdtempSync(join(tmpdir(), 'bot-test-')), 'db.sqlite'));
    const { bot, sentTo } = migratingApi(db);
    const chat = new ChatTarget(db, OLD);
    const { TelegramNotifier } = await import('../src/telegram.ts');
    const listing = db.insert(baseListing, 'fp', new Date().toISOString());
    const msgId = await new TelegramNotifier(bot, chat).send({ kind: 'new', listing });
    assert.equal(msgId, 1);
    assert.equal(chat.id, NEW);
    assert.equal(sentTo.at(-1), NEW);
    // The migration is tied to the configured id: another chat in .env is not redirected
    assert.equal(new ChatTarget(db, '-999').id, '-999');
  });

  it("follows Telegram's service message about the upgrade", async () => {
    const db = new ListingsDb(join(mkdtempSync(join(tmpdir(), 'bot-test-')), 'db.sqlite'));
    const { bot } = migratingApi(db);
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: Number(NEW), type: 'supergroup', title: 'g' }, migrate_from_chat_id: Number(OLD) } } as never);
    assert.equal(new ChatTarget(db, OLD).id, NEW);
  });
});

describe('/status', () => {
  it('counts only cards that reached the chat and shows each site', () => {
    const db = new ListingsDb(join(mkdtempSync(join(tmpdir(), 'bot-test-')), 'db.sqlite'));
    const now = new Date().toISOString();
    const sent = db.insert({ ...baseListing, sourceId: 'a' }, 'a', now);
    db.markNotified(sent.id, 1, now);
    db.setStatus(sent.id, 'liked');
    db.insert({ ...baseListing, sourceId: 'b' }, 'b', now); // seeded, never shown
    db.setMeta('last_poll_at', now);
    db.setMeta('source_stats', JSON.stringify([
      { name: '4zida:prodaja-stanova/beograd', checked: 78, error: null },
      { name: 'nekretnine', checked: 0, error: 'Error: nekretnine https://x -> HTTP 403 (DataDome)' },
    ]));
    db.setMeta('health:nekretnine:fails', '2');
    const text = statusText(db);
    assert.match(text, /Sent to chat: 1 · 👍 1 · 👎 0/);
    assert.match(text, /✅ 4zida apartments: checked 78/);
    assert.match(text, /⚠️ nekretnine: HTTP 403 \(2 polls in a row\)/);
    db.close();
  });
});

describe('reliability', () => {
  const fresh = () => new ListingsDb(join(mkdtempSync(join(tmpdir(), 'bot-test-')), 'db.sqlite'));

  it('a card Telegram keeps rate-limiting is reported as failed, not as sent', async () => {
    const db = fresh();
    const bot = createBot('1:test', { db, chat: new ChatTarget(db, String(CHAT)), triggerPoll: async () => '' });
    bot.api.config.use(async () => ({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } }) as never);
    const { TelegramNotifier } = await import('../src/telegram.ts');
    const listing = db.insert(baseListing, 'fp', new Date().toISOString());
    await assert.rejects(new TelegramNotifier(bot, new ChatTarget(db, String(CHAT))).send({ kind: 'new', listing }));
  });

  it('Unlike from a stale /liked list does not undo a dislike', async () => {
    const db = fresh();
    const l = db.insert(baseListing, 'fp', new Date().toISOString());
    db.setStatus(l.id, 'disliked');
    const h = harness(db);
    await h.press(`lk:${l.id}:unlike`, 900);
    assert.equal(db.get(l.id)!.status, 'disliked');
  });

  it('Dislike on a price-drop card removes the original card too', async () => {
    const db = fresh();
    const l = db.insert(baseListing, 'fp', new Date().toISOString());
    db.markNotified(l.id, 777, new Date().toISOString());
    db.addExtraMessage(l.id, 888);
    const h = harness(db);
    await h.press(`st:${l.id}:disliked`, 888);
    const deleted = h.calls.filter((c) => c.method === 'deleteMessage').map((c) => c.payload.message_id);
    assert.deepEqual(deleted.sort(), [777, 888]);
  });

  it('/poll does not block other updates while the poll runs', async () => {
    const db = fresh();
    const bot = createBot('1:test', { db, chat: new ChatTarget(db, String(CHAT)), triggerPoll: () => new Promise<string>(() => {}) });
    bot.botInfo = { id: 1, is_bot: true, first_name: 'bot', username: 'test_bot' } as Bot['botInfo'];
    bot.api.config.use(async () => ({ ok: true, result: { message_id: 1, date: 0, chat } }) as never);
    const handled = bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, chat, from, text: '/poll', entities: [{ type: 'bot_command', offset: 0, length: 5 }] } } as never);
    const result = await Promise.race([handled.then(() => 'done'), new Promise((r) => setTimeout(() => r('blocked'), 500))]);
    assert.equal(result, 'done');
  });
});
