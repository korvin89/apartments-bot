import { InlineKeyboard, type Bot } from 'grammy';
import type { ListingsDb } from './db.js';
import { esc, fmtMoney } from './format.js';
import { log } from './config.js';
import type { SearchConfig } from './search.config.js';
import {
  loadSearchConfig,
  parseField,
  applyPlacesEdit,
  resetFilters,
  updateFilters,
  type NumericField,
} from './settings.js';
import type { BuildingAge, PropertyType } from './types.js';

const AGE_LABEL: Record<BuildingAge, string> = { any: 'resale + new builds', resale: 'resale only', new: 'new builds only' };
const AGE_NEXT: Record<BuildingAge, BuildingAge> = { any: 'resale', resale: 'new', new: 'any' };

type PlaceField = 'excludePlaces' | 'includePlaces' | 'includePlacesHousesOnly';
type InputField = NumericField | PlaceField;
type ToggleField =
  | 'requireRegistered'
  | 'requireCreditEligible'
  | 'excludeBasement'
  | 'excludeGroundFloor'
  | 'excludeAttic'
  | 'excludeLastFloor'
  | 'excludeStorageHeating';

const PLACES_HELP =
  'Reply with "+ banjica, zarkovo" to add, "- lesce" to remove, a full comma-separated list to replace, or "none" to clear. ' +
  'Matches any part of the neighborhood name in the listing URL.';

/** Long lists are summarized in the panel; the full list is shown in the edit prompt. */
function placesSummary(list: string[], empty: string): string {
  if (list.length === 0) return empty;
  if (list.length <= 8) return esc(list.join(', '));
  return `${esc(list.slice(0, 5).join(', '))} … ${list.length} in total`;
}

const PROMPTS: Record<InputField, (cfg: SearchConfig) => string> = {
  maxPrice: (c) => `💰 Send the new <b>max price</b> in EUR. Now: ${fmtMoney(c.maxPrice)} €.\nExamples: 200000, 200k`,
  minPrice: (c) => `💰 Send the new <b>min price</b> in EUR, or "any". Now: ${c.minPrice ? `${fmtMoney(c.minPrice)} €` : 'any'}.`,
  minM2: (c) => `📐 Send the <b>min area</b> in m², or "any". Now: ${c.minM2 ?? 'any'}.`,
  maxM2: (c) => `📐 Send the <b>max area</b> in m², or "any". Now: ${c.maxM2 ?? 'any'}.`,
  minRooms: (c) => `🚪 Send the <b>min number of rooms</b> (2, 2.5, 3…), or "any". Now: ${c.minRooms ?? 'any'}.`,
  maxPricePerM2: (c) => `💶 Send the <b>max price per m²</b> in EUR, or "any". Now: ${c.maxPricePerM2 ? `${fmtMoney(c.maxPricePerM2)} €` : 'any'}.`,
  maxFloorWithoutElevator: (c) =>
    `🛗 If a building has <b>no elevator</b>, what is the highest floor you accept? Send a number, or "any".\n` +
    `Now: ${c.maxFloorWithoutElevator ?? 'any'}.`,
  includePlaces: (c) =>
    `📍 <b>Only these places</b> (apartments and houses).\n${PLACES_HELP}\n\n` +
    `Now (${c.includePlaces.length}): ${c.includePlaces.length ? esc(c.includePlaces.join(', ')) : 'everywhere'}`,
  includePlacesHousesOnly: (c) =>
    `🏡 <b>Extra places for houses</b>, on top of the main list.\n${PLACES_HELP}\n\n` +
    `Now (${c.includePlacesHousesOnly.length}): ${c.includePlacesHousesOnly.length ? esc(c.includePlacesHousesOnly.join(', ')) : 'none'}`,
  excludePlaces: (c) =>
    `🚫 <b>Excluded places</b>.\n${PLACES_HELP}\n\n` +
    `Now (${c.excludePlaces.length}): ${c.excludePlaces.length ? esc(c.excludePlaces.join(', ')) : 'none'}`,
};

const PLACEHOLDERS: Record<InputField, string> = {
  maxPrice: '200000',
  minPrice: 'any',
  minM2: '55',
  maxM2: '150',
  minRooms: '2',
  maxPricePerM2: '2800',
  maxFloorWithoutElevator: '3',
  includePlaces: '+ banjica',
  includePlacesHousesOnly: '+ zarkovo',
  excludePlaces: '+ grocka',
};

function onOff(v: boolean): string {
  return v ? 'yes' : 'no';
}

function areaRange(min: number | null, max: number | null): string {
  if (min && max) return `${min} – ${max} m²`;
  if (min) return `from ${min} m²`;
  if (max) return `up to ${max} m²`;
  return 'any';
}

export function filtersText(cfg: SearchConfig): string {
  const types = cfg.types.map((t) => (t === 'house' ? 'houses' : 'apartments')).join(', ');
  const floors = [
    cfg.excludeBasement ? 'no basement' : null,
    cfg.excludeGroundFloor ? 'no ground floor' : null,
    cfg.excludeAttic ? 'no attic' : null,
    cfg.excludeLastFloor ? 'no top floor' : null,
    cfg.maxFloorWithoutElevator !== null ? `max ${cfg.maxFloorWithoutElevator} without elevator` : null,
  ].filter(Boolean);
  return [
    '🔎 <b>Search filters</b>',
    `💰 Price: ${cfg.minPrice ? `${fmtMoney(cfg.minPrice)} – ` : 'up to '}${fmtMoney(cfg.maxPrice)} €`,
    `💶 Price per m²: ${cfg.maxPricePerM2 ? `up to ${fmtMoney(cfg.maxPricePerM2)} €` : 'any'}`,
    `📐 Area: ${areaRange(cfg.minM2, cfg.maxM2)}`,
    `🚪 Rooms: ${cfg.minRooms ? `from ${cfg.minRooms}` : 'any'}`,
    `🏠 Types: ${types}`,
    `🏗 Buildings: ${AGE_LABEL[cfg.buildingAge]}`,
    `🏢 Floor (apartments): ${floors.length ? floors.join(', ') : 'any'}`,
    `✅ Hide "not registered": ${onOff(cfg.requireRegistered)}`,
    `🏦 Mortgage-eligible only: ${onOff(cfg.requireCreditEligible)}`,
    `🔥 Hide TA heating (apartments): ${onOff(cfg.excludeStorageHeating)}`,
    `📍 Only places: ${placesSummary(cfg.includePlaces, 'everywhere')}`,
    cfg.includePlaces.length ? `🏡 Extra places for houses: ${placesSummary(cfg.includePlacesHousesOnly, 'none')}` : null,
    `🚫 Excluded places: ${placesSummary(cfg.excludePlaces, 'none')}`,
    '',
    '<i>Changes apply from the next poll. Listings missing a detail are not filtered out by it.</i>',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export function filtersKeyboard(cfg: SearchConfig): InlineKeyboard {
  const check = (v: boolean) => (v ? '✓' : '✗');
  return new InlineKeyboard()
    .text('💰 Max price', 'f:in:maxPrice')
    .text('💰 Min price', 'f:in:minPrice')
    .text('💶 Max €/m²', 'f:in:maxPricePerM2')
    .row()
    .text('📐 Min area', 'f:in:minM2')
    .text('📐 Max area', 'f:in:maxM2')
    .text('🚪 Min rooms', 'f:in:minRooms')
    .row()
    .text(`🏢 Apartments ${check(cfg.types.includes('apartment'))}`, 'f:type:apartment')
    .text(`🏡 Houses ${check(cfg.types.includes('house'))}`, 'f:type:house')
    .row()
    .text(`🏗 ${cap(AGE_LABEL[cfg.buildingAge])}`, 'f:age')
    .row()
    .text(`No basement ${check(cfg.excludeBasement)}`, 'f:tg:excludeBasement')
    .text(`No ground floor ${check(cfg.excludeGroundFloor)}`, 'f:tg:excludeGroundFloor')
    .row()
    .text(`No attic ${check(cfg.excludeAttic)}`, 'f:tg:excludeAttic')
    .text(`No top floor ${check(cfg.excludeLastFloor)}`, 'f:tg:excludeLastFloor')
    .row()
    .text('🛗 Max floor without elevator', 'f:in:maxFloorWithoutElevator')
    .row()
    .text(`✅ Hide not registered ${check(cfg.requireRegistered)}`, 'f:tg:requireRegistered')
    .text(`🏦 Mortgage ${check(cfg.requireCreditEligible)}`, 'f:tg:requireCreditEligible')
    .row()
    .text(`🔥 No TA heating ${check(cfg.excludeStorageHeating)}`, 'f:tg:excludeStorageHeating')
    .row()
    .text('📍 Only places', 'f:in:includePlaces')
    .text('🏡 Houses extra', 'f:in:includePlacesHousesOnly')
    .text('🚫 Excluded', 'f:in:excludePlaces')
    .row()
    .text('↩️ Reset to defaults', 'f:reset')
    .text('✖ Close', 'f:close');
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface PendingInput {
  field: InputField;
  panelMessageId: number;
}

/**
 * Registers /filters and its buttons. Call after all other commands:
 * it adds a text handler for replies to the bot's prompts.
 */
export function registerFilters(bot: Bot, db: ListingsDb): void {
  // prompt message id -> what it asks for. In memory: a restart just drops open prompts.
  const pending = new Map<number, PendingInput>();

  const refreshPanel = async (chatId: number, messageId: number, cfg: SearchConfig) => {
    try {
      await bot.api.editMessageText(chatId, messageId, filtersText(cfg), {
        parse_mode: 'HTML',
        reply_markup: filtersKeyboard(cfg),
      });
    } catch (e) {
      // "message is not modified" or the panel was deleted: send a fresh one
      if (!String(e).includes('not modified')) {
        await bot.api.sendMessage(chatId, filtersText(cfg), { parse_mode: 'HTML', reply_markup: filtersKeyboard(cfg) });
      }
    }
  };

  bot.command('filters', (ctx) => {
    const cfg = loadSearchConfig(db);
    return ctx.reply(filtersText(cfg), { parse_mode: 'HTML', reply_markup: filtersKeyboard(cfg) });
  });

  bot.callbackQuery(/^f:in:(maxPrice|minPrice|minM2|maxM2|minRooms|maxPricePerM2|maxFloorWithoutElevator|includePlaces|includePlacesHousesOnly|excludePlaces)$/, async (ctx) => {
    const field = ctx.match[1] as InputField;
    const panel = ctx.callbackQuery.message;
    if (!panel) return ctx.answerCallbackQuery();
    const prompt = await ctx.reply(PROMPTS[field](loadSearchConfig(db)), {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: PLACEHOLDERS[field] },
    });
    pending.set(prompt.message_id, { field, panelMessageId: panel.message_id });
    if (pending.size > 50) pending.delete(pending.keys().next().value!);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^f:type:(apartment|house)$/, async (ctx) => {
    const type = ctx.match[1] as PropertyType;
    const cfg = loadSearchConfig(db);
    const types = cfg.types.includes(type) ? cfg.types.filter((t) => t !== type) : [...cfg.types, type];
    if (types.length === 0) return ctx.answerCallbackQuery('Keep at least one type.');
    const next = updateFilters(db, { types });
    await ctx.editMessageText(filtersText(next), { parse_mode: 'HTML', reply_markup: filtersKeyboard(next) });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^f:tg:(requireRegistered|requireCreditEligible|excludeBasement|excludeGroundFloor|excludeAttic|excludeLastFloor|excludeStorageHeating)$/, async (ctx) => {
    const key = ctx.match[1] as ToggleField;
    const next = updateFilters(db, { [key]: !loadSearchConfig(db)[key] });
    await ctx.editMessageText(filtersText(next), { parse_mode: 'HTML', reply_markup: filtersKeyboard(next) });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('f:age', async (ctx) => {
    const next = updateFilters(db, { buildingAge: AGE_NEXT[loadSearchConfig(db).buildingAge] });
    await ctx.editMessageText(filtersText(next), { parse_mode: 'HTML', reply_markup: filtersKeyboard(next) });
    await ctx.answerCallbackQuery(AGE_LABEL[next.buildingAge]);
  });

  bot.callbackQuery('f:reset', async (ctx) => {
    const next = resetFilters(db);
    await ctx.editMessageText(filtersText(next), { parse_mode: 'HTML', reply_markup: filtersKeyboard(next) }).catch(() => {});
    await ctx.answerCallbackQuery(`Filters reset by ${ctx.from.first_name}`);
  });

  bot.callbackQuery('f:close', async (ctx) => {
    await ctx.deleteMessage().catch(() => ctx.editMessageReplyMarkup({ reply_markup: undefined }));
    await ctx.answerCallbackQuery();
  });

  // Replies to the bot's prompts
  bot.on('message:text', async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    const p = replyTo !== undefined ? pending.get(replyTo) : undefined;
    if (!p) return next();

    const text = ctx.message.text;
    const cfg = loadSearchConfig(db);
    let patch;
    if (p.field === 'excludePlaces' || p.field === 'includePlaces' || p.field === 'includePlacesHousesOnly') {
      patch = { [p.field]: applyPlacesEdit(cfg[p.field], text) };
    } else {
      const r = parseField(p.field, text, cfg);
      if (!r.ok) {
        // Keep the prompt open so they can just reply again
        await ctx.reply(`⚠️ ${r.error}`, { reply_parameters: { message_id: ctx.message.message_id } });
        return;
      }
      patch = r.value;
    }

    pending.delete(replyTo!);
    const updated = updateFilters(db, patch);
    log(`Filters changed by ${ctx.from.first_name}: ${JSON.stringify(patch)}`);
    // Tidy up the prompt and the answer; needs admin rights for the user's message, so best effort
    await ctx.api.deleteMessage(ctx.chat.id, replyTo!).catch(() => {});
    await ctx.deleteMessage().catch(() => {});
    await refreshPanel(ctx.chat.id, p.panelMessageId, updated);
  });
}
