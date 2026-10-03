import 'dotenv/config';

export const env = {
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  chatId: process.env.TELEGRAM_CHAT_ID ?? '',
  pollIntervalMinutes: Number(process.env.POLL_INTERVAL_MINUTES ?? 10),
  dbPath: process.env.DB_PATH ?? './data/listings.db',
  notifyOnFirstRun: process.env.NOTIFY_ON_FIRST_RUN === 'true',
  /** curl-impersonate binary for halooglasi.com; the source is skipped if it is missing. */
  curlImpersonate: process.env.CURL_IMPERSONATE ?? './bin/curl-impersonate',
  /** Consecutive failed polls before the bot posts a warning to the chat. */
  healthAlertAfter: Number(process.env.HEALTH_ALERT_AFTER ?? 3),
};

export { log, warn, logError } from './logger.js';
