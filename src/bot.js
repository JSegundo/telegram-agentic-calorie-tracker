import 'dotenv/config';
import axios from 'axios';
import { Telegraf } from 'telegraf';
import { analyzeMeal, calculateMeal } from './claude.js';
import { appendMeal } from './sheets.js';

const allowed = new Set(process.env.ALLOWED_USER_IDS.split(',').map((id) => id.trim()));
// Claude calls can take a while; don't let Telegraf time the handler out mid-meal.
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, { handlerTimeout: Infinity });

// chatId -> { meal, at, preguntas, respuestas }
const sessions = new Map();

// Telegraf handles updates of the same batch concurrently. Chain each chat's updates
// so a session is never read/mutated by two handlers at once (e.g. an answer sent mid-analysis).
const queues = new Map();
bot.use((ctx, next) => {
  if (!allowed.has(String(ctx.from?.id))) return;
  const id = ctx.chat.id;
  const run = (queues.get(id) ?? Promise.resolve()).then(next).catch((err) => {
    console.error(err);
    return ctx.reply('⚠️ Algo falló. Probá de nuevo.').catch(() => {});
  });
  queues.set(id, run);
  return run.finally(() => queues.get(id) === run && queues.delete(id));
});

bot.start((ctx) => ctx.reply('Mandame una foto de tu comida (con descripción opcional) o describila con texto.'));

bot.command('cancelar', (ctx) => {
  sessions.delete(ctx.chat.id);
  return ctx.reply('Cancelado.');
});

bot.on('photo', async (ctx) => {
  const { file_id } = ctx.message.photo.at(-1); // largest size
  const link = await ctx.telegram.getFileLink(file_id);
  const { data } = await axios.get(link.href, { responseType: 'arraybuffer' });
  await startMeal(ctx, { image: Buffer.from(data).toString('base64'), text: ctx.message.caption });
});

bot.on('text', async (ctx) => {
  const session = sessions.get(ctx.chat.id);
  if (!session) return startMeal(ctx, { text: ctx.message.text });

  session.respuestas.push(ctx.message.text);
  const { preguntas, respuestas } = session;
  if (respuestas.length < preguntas.length) return ctx.reply(question(session));

  await ctx.sendChatAction('typing');
  const { meal, at } = session;
  let r;
  try {
    r = await calculateMeal(meal, preguntas, respuestas, at.toLocaleString('es-AR'));
    const notas = meal.image ? 'Foto enviada por bot' : 'Texto enviado por bot';
    await appendMeal([at.toLocaleDateString('en-CA'), r.tipo, r.descripcion, r.calorias, `${r.proteina}g`, notas]);
  } catch (err) {
    respuestas.pop(); // nothing was saved: let the user resend the last answer to retry
    throw err;
  }
  sessions.delete(ctx.chat.id);
  await ctx.reply(`✅ Guardado: ${r.tipo} — ${r.descripcion}\n🔥 ${r.calorias} kcal · 💪 ${r.proteina}g proteína\n\n${r.detalle}`);
});

async function startMeal(ctx, meal) {
  const at = new Date(); // when the meal was sent, not when the last answer arrives
  await ctx.sendChatAction('typing');
  const { descripcion, preguntas } = await analyzeMeal(meal);
  const session = { meal, at, preguntas, respuestas: [] };
  sessions.set(ctx.chat.id, session);
  await ctx.reply(`🍽️ ${descripcion}\n\nTe hago 3 preguntas para afinar el cálculo (/cancelar para salir).`);
  await ctx.reply(question(session));
}

const question = ({ preguntas, respuestas }) => `${respuestas.length + 1}/3: ${preguntas[respuestas.length]}`;

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
