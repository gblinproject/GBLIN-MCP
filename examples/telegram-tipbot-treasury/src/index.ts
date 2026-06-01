import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { getBotStats } from './stats.js';
import { suggestTreasuryAction } from './treasury.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WALLET = process.env.BOT_WALLET_ADDRESS as `0x${string}` | undefined;
const TIP_URL = process.env.TIP_PAYMENT_URL || 'https://gblin.digital';

if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set');
if (!WALLET) throw new Error('BOT_WALLET_ADDRESS not set');

const bot = new Telegraf(TOKEN);

bot.command('start', async (ctx) => {
  await ctx.reply(
    [
      'Hi! I accept tips in USDC on Base.',
      '',
      '/tip — Send me a USDC tip',
      '/stats — See my live treasury stats',
      '/about — Learn how I work',
    ].join('\n')
  );
});

bot.command('about', async (ctx) => {
  await ctx.reply(
    [
      'I am a Telegram bot powered by GBLIN treasury.',
      '',
      'When you tip me, your USDC arrives on Base mainnet at my wallet.',
      'When my USDC balance grows above $5, I auto-invest the excess into the GBLIN treasury-backed index.',
      'My value grows passively while keeping liquidity for operational needs.',
      '',
      `My wallet: ${WALLET}`,
      `Verify on Basescan: https://basescan.org/address/${WALLET}`,
      '',
      'Built on Base. Powered by GBLIN. Fork the source: https://github.com/gblinproject/GBLIN-MCP',
    ].join('\n')
  );
});

bot.command('tip', async (ctx) => {
  await ctx.reply(
    [
      'Thank you for considering a tip!',
      '',
      `Send USDC on Base to: \`${WALLET}\``,
      '',
      `Or use the payment link: ${TIP_URL}`,
      '',
      'Tips auto-invest into GBLIN treasury for sustainability.',
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );
});

bot.command('stats', async (ctx) => {
  try {
    const stats = await getBotStats(WALLET);
    const suggestion = suggestTreasuryAction(stats.usdc, WALLET);
    await ctx.reply(
      [
        'Bot Treasury Stats',
        '',
        `USDC balance: $${stats.usdc.toFixed(4)}`,
        `GBLIN holdings: ${stats.gblin.toFixed(6)} (= $${stats.gblinValueUsdc.toFixed(4)})`,
        `Total treasury: $${stats.totalUsdc.toFixed(4)}`,
        '',
        `Suggested action: ${suggestion.action.toUpperCase()}`,
        `Reason: ${suggestion.reason}`,
        '',
        `Verify on-chain: ${stats.basescanUrl}`,
      ].join('\n')
    );
  } catch (e: any) {
    await ctx.reply(`Error fetching stats: ${e.message}`);
  }
});

bot.launch();
console.log('Telegram tip bot running');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
