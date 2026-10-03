import { env, log, logError, warn } from './config.js';
import { ListingsDb } from './db.js';
import { runPoll, summaryText } from './poll.js';
import { loadSearchConfig } from './settings.js';
import { BOT_COMMANDS, ChatTarget, TelegramNotifier, createBot } from './telegram.js';
import { esc } from './format.js';

process.on('unhandledRejection', (reason) => logError('Unhandled promise rejection', reason));
process.on('uncaughtException', (err) => {
  logError('Uncaught exception, exiting', err);
  process.exit(1);
});

async function main(): Promise<void> {
  const db = new ListingsDb(env.dbPath);
  const cfg = loadSearchConfig(db);
  log(
    `Starting: poll every ${env.pollIntervalMinutes} min, sources ${Object.entries(cfg.sources)
      .filter(([, on]) => on)
      .map(([k]) => k)
      .join(', ')}, max price ${cfg.maxPrice}, db ${env.dbPath}`,
  );

  if (!env.botToken) {
    logError('TELEGRAM_BOT_TOKEN is not set. Fill in .env (see README). For a console dry run use `pnpm poll`.');
    process.exit(1);
  }
  const chat = new ChatTarget(db, env.chatId);
  const bot = createBot(env.botToken, { db, chat, triggerPoll });
  const notifier = new TelegramNotifier(bot, chat);

  async function triggerPoll(): Promise<string> {
    try {
      const s = await runPoll({ db, notifier, cfg: loadSearchConfig(db), notifyOnFirstRun: env.notifyOnFirstRun });
      const text = summaryText(s);
      log(text.replace(/\n/g, ' | '));
      return text;
    } catch (e) {
      logError('Poll failed', e);
      return `Poll failed: ${String(e)}`;
    }
  }

  bot.api.setMyCommands(BOT_COMMANDS).catch((e) => warn('setMyCommands failed', String(e)));
  // If receiving updates stops (409: another copy runs with this token; 401: token revoked),
  // buttons and commands would silently die while cards keep coming. Exit instead, so the
  // problem is visible and systemd restarts the bot.
  bot.start({ onStart: (me) => log(`Bot @${me.username} started`) }).catch(async (e) => {
    logError('Stopped receiving Telegram updates, exiting', e);
    const hint = String(e).includes('409') ? 'Another copy of the bot is running with the same token.' : esc(String(e));
    if (chat.isSet) await notifier.alert(`⚠️ I stopped receiving button presses and commands. ${hint} Restarting.`).catch(() => {});
    process.exit(1);
  });

  if (!chat.isSet) {
    // Polling now would spend the first run (the welcome and the overview) on nobody.
    log('TELEGRAM_CHAT_ID is not set: send /start in your group to get its id, put it in .env and restart. Not polling until then.');
    return;
  }

  await triggerPoll();
  const timer = setInterval(triggerPoll, env.pollIntervalMinutes * 60_000);
  log(`Next poll in ${env.pollIntervalMinutes} min`);

  const shutdown = async () => {
    log('Shutting down');
    clearInterval(timer);
    await bot.stop();
    db.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((e) => {
  logError('Fatal error on startup', e);
  process.exit(1);
});
