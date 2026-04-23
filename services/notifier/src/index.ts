import './load-env.js';
import { execSync } from 'node:child_process';
import cors from 'cors';
import express from 'express';
import { logger, setupErrorEmitter } from '@hermes/logger';

setupErrorEmitter(logger);

const app = express();
const port = Number(process.env.PORT ?? 4312);
const POLL_INTERVAL_MS = 5_000;
const API_URL = 'http://localhost:4300/api/journal';

const WIN_SOUND = '/mnt/Storage/github/hermes-trading-firm/apps/web/static/sounds/coins_cave01.wav';
const LOSS_SOUND = '/mnt/Storage/github/hermes-trading-firm/apps/web/static/sounds/stab.wav';

const seenTradeIds = new Set<string>();
let isFirstPoll = true;

app.use(cors());

app.get('/health', (_req, res) => {
  res.json({
    service: 'notifier',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    trackedTrades: seenTradeIds.size
  });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[notifier] listening on http://0.0.0.0:${port}`);
  startPolling();
});

function findAudioPlayer(): string | null {
  const players = ['afplay', 'paplay', 'mpg123', 'aplay'];
  for (const player of players) {
    try {
      execSync(`command -v ${player}`, { stdio: 'ignore' });
      return player;
    } catch {
      // not available
    }
  }
  return null;
}

const audioPlayer = findAudioPlayer();

function playSound(path: string): void {
  if (!audioPlayer) {
    logger.warn({ component: 'notifier' }, 'No audio player found; skipping sound playback');
    return;
  }
  try {
    const cmd = audioPlayer === 'paplay' ? `${audioPlayer} "${path}"` : `${audioPlayer} "${path}"`;
    execSync(cmd, { stdio: 'ignore', timeout: 5_000 });
    logger.info({ component: 'notifier' }, `Played ${path} via ${audioPlayer}`);
  } catch (err) {
    logger.error({ component: 'notifier', err }, `Failed to play sound: ${path}`);
  }
}

async function pollJournal(): Promise<void> {
  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      logger.warn({ component: 'notifier' }, `journal returned ${res.status}`);
      return;
    }
    const trades = await res.json() as Array<{
      id: string;
      realizedPnl: number;
      verdict?: string;
      symbol?: string;
      broker?: string;
    }>;

    if (isFirstPoll) {
      for (const trade of trades) {
        seenTradeIds.add(trade.id);
      }
      isFirstPoll = false;
      logger.info({ component: 'notifier' }, `Seeded ${seenTradeIds.size} existing trade IDs`);
      return;
    }

    for (const trade of trades) {
      if (seenTradeIds.has(trade.id)) continue;
      seenTradeIds.add(trade.id);

      const pnl = trade.realizedPnl ?? 0;
      if (pnl >= 0.01) {
        logger.info({ component: 'notifier', tradeId: trade.id, pnl: pnl, verdict: trade.verdict }, 'Win detected');
        playSound(WIN_SOUND);
      } else if (pnl <= -0.01) {
        logger.info({ component: 'notifier', tradeId: trade.id, pnl: pnl, verdict: trade.verdict }, 'Loss detected');
        playSound(LOSS_SOUND);
      }
    }
  } catch (err) {
    logger.error({ component: 'notifier', err }, 'Failed to poll journal');
  }
}

function startPolling(): void {
  pollJournal();
  setInterval(pollJournal, POLL_INTERVAL_MS);
}

function shutdown(): void {
  logger.info({ component: 'notifier' }, 'Shutting down...');
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
