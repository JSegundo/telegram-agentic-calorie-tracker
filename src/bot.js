import 'dotenv/config';
import axios from 'axios';
import { Telegraf } from 'telegraf';
import { analyzeMeal, calculateMeal, calculateMeals } from './claude.js';
import { appendMeal } from './sheets.js';
import { log } from './log.js';

const allowed = new Set(process.env.ALLOWED_USER_IDS.split(',').map((id) => id.trim()));
// Claude calls can take a while; don't let Telegraf time the handler out mid-meal.
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, { handlerTimeout: Infinity });

// weekday + ISO date + time: claude.js needs an unambiguous "today" to resolve "ayer"/"el lunes pasado".
const localNow = (at) => `${at.toLocaleDateString('es-CR', { weekday: 'long' })} ${at.toLocaleDateString('en-CA')} ${at.toLocaleTimeString('es-CR')}`;

// chatId -> { meal, analisis, at, preguntas, respuestas, lastActivity }
const sessions = new Map();

// sweeps sessions idle past SESSION_TIMEOUT_MS — otherwise an abandoned meal (unanswered
// questions) leaks forever. lastActivity tracks idle time; `at` stays the original send
// time since claude.js uses it as "today" for date math.
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SESSION_TIMEOUT_MS;
  for (const [id, session] of sessions) {
    if (session.lastActivity < cutoff) {
      log(`session expired: chat=${id}`);
      sessions.delete(id);
    }
  }
}, 60 * 1000);

// Telegraf handles updates of the same batch concurrently. Chain each chat's updates
// so a session is never read/mutated by two handlers at once (e.g. an answer sent mid-analysis).
const queues = new Map();
bot.use((ctx, next) => {
  const kind = ctx.updateType === 'message' ? Object.keys(ctx.message).find((k) => k !== 'message_id' && k !== 'date' && k !== 'chat' && k !== 'from') : ctx.updateType;
  log(`update kind=${kind} from=${ctx.from?.id} chat=${ctx.chat?.id}`);
  if (!allowed.has(String(ctx.from?.id))) return log(`blocked: from=${ctx.from?.id} not in ALLOWED_USER_IDS`);
  const id = ctx.chat.id;
  const run = (queues.get(id) ?? Promise.resolve()).then(next).catch((err) => {
    log('error:', err);
    // err.userMessage (set at specific throw sites) gives a step-specific message; falls back to the generic one otherwise
    return ctx.reply(err.userMessage ?? '⚠️ Algo falló. Probá de nuevo.').catch(() => {});
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
  log(`photo: chat=${ctx.chat.id} downloading file_id=${file_id}`);
  const link = await ctx.telegram.getFileLink(file_id);
  let data;
  try {
    data = (await axios.get(link.href, { responseType: 'arraybuffer' })).data;
  } catch (err) {
    // tagged separately so a download failure doesn't look like an analysis/save failure
    err.userMessage = '⚠️ No pude descargar la foto de Telegram. Probá de nuevo.';
    throw err;
  }
  log(`photo: chat=${ctx.chat.id} downloaded ${data.byteLength} bytes`);
  await startMeal(ctx, { image: Buffer.from(data).toString('base64'), text: ctx.message.caption });
});

bot.on('text', async (ctx) => {
  const session = sessions.get(ctx.chat.id);
  if (!session) return startMeal(ctx, { text: ctx.message.text });

  session.respuestas.push(ctx.message.text);
  session.lastActivity = Date.now(); // keeps the session alive for the expiry sweep above
  const { preguntas, respuestas } = session;
  if (respuestas.length < preguntas.length) return ctx.reply(question(session));

  await (session.batch ? finishMeals : finishMeal)(ctx, session);
});

// shared by bot.on('text') and startMeal() (when preguntas=[] skips straight here)
async function finishMeal(ctx, { meal, analisis, at, preguntas, respuestas }) {
  await ctx.sendChatAction('typing');
  let r;
  log(`calculateMeal: chat=${ctx.chat.id} start`);
  try {
    r = await calculateMeal(meal, analisis, preguntas, respuestas, localNow(at));
  } catch (err) {
    respuestas.pop(); // nothing was saved: let the user resend the last answer to retry (no-op if there wasn't one)
    throw err;
  }
  log(`calculateMeal: chat=${ctx.chat.id} done valido=${r.valido} descripcion=${JSON.stringify(r.descripcion)}`);
  // r.valido: nonsense answer rejected here (restarts) instead of writing a bogus row
  if (!r.valido) {
    sessions.delete(ctx.chat.id);
    return ctx.reply(r.descripcion);
  }
  try {
    const notas = meal.image ? 'Foto enviada por bot' : 'Texto enviado por bot';
    // r.fecha (not at): lets "lo comí ayer" land on the right day instead of the send date
    await appendMeal([r.fecha, r.tipo, r.descripcion, r.calorias, r.proteina, notas]); // number, not "Ng", so the sheet can SUM() it
    log(`appendMeal: chat=${ctx.chat.id} saved`);
  } catch (err) {
    // tagged separately: totals computed fine, only the Sheets write failed — session stays alive so the same answer can retry
    respuestas.pop();
    err.userMessage = '⚠️ Se calculó pero no se pudo guardar en la planilla. Probá de nuevo.';
    throw err;
  }
  sessions.delete(ctx.chat.id);
  await ctx.reply(`✅ Guardado: ${r.tipo} — ${r.descripcion}\n🔥 ${r.calorias} kcal · 💪 ${r.proteina}g proteína\n\n${r.detalle}`);
}

// Batch counterpart of finishMeal, for a day-backfill message ("ayer desayuné X, almorcé
// Y, cené Z"). appendMeal runs in a loop here, so a failure partway through can re-save
// rows that already succeeded on retry — acceptable for a personal single-user sheet.
async function finishMeals(ctx, { meal, analisis, at, preguntas, respuestas }) {
  await ctx.sendChatAction('typing');
  let r;
  log(`calculateMeals: chat=${ctx.chat.id} start`);
  try {
    r = await calculateMeals(meal.text, analisis, preguntas, respuestas, localNow(at));
  } catch (err) {
    respuestas.pop();
    throw err;
  }
  log(`calculateMeals: chat=${ctx.chat.id} done valido=${r.valido} n=${r.comidas?.length}`);
  if (!r.valido) {
    sessions.delete(ctx.chat.id);
    return ctx.reply('⚠️ No entendí bien alguna respuesta. Probá de nuevo.');
  }
  try {
    for (const m of r.comidas) {
      await appendMeal([m.fecha, m.tipo, m.descripcion, m.calorias, m.proteina, 'Cargado en lote por bot']);
    }
    log(`appendMeal: chat=${ctx.chat.id} saved batch of ${r.comidas.length}`);
  } catch (err) {
    respuestas.pop();
    err.userMessage = '⚠️ Se calculó pero no se pudo guardar todo en la planilla. Probá de nuevo.';
    throw err;
  }
  sessions.delete(ctx.chat.id);
  const resumen = r.comidas.map((m) => `${m.tipo} (${m.fecha}): ${m.descripcion} — 🔥${m.calorias} kcal · 💪${m.proteina}g`).join('\n');
  await ctx.reply(`✅ Guardadas ${r.comidas.length} comidas:\n${resumen}`);
}

async function startMeal(ctx, meal) {
  const at = new Date(); // when the meal was sent, not when the last answer arrives
  await ctx.sendChatAction('typing');
  log(`analyzeMeal: chat=${ctx.chat.id} start`);
  const { descripcion, preguntas, valido, esConsulta, esMultiple } = await analyzeMeal(meal, localNow(at));
  log(`analyzeMeal: chat=${ctx.chat.id} done valido=${valido} esConsulta=${esConsulta} esMultiple=${esMultiple} preguntas=${preguntas.length} descripcion=${JSON.stringify(descripcion)}`);
  if (esConsulta) return ctx.reply(descripcion); // history query ("cómo estuvo ayer"), already answered — nothing to log
  if (!valido) return ctx.reply(descripcion); // junk input, nothing to ask
  const finish = esMultiple ? finishMeals : finishMeal;
  if (preguntas.length === 0) return finish(ctx, { meal, analisis: descripcion, at, preguntas, respuestas: [] }); // standard meal(s), skip straight to finish
  const session = { meal, analisis: descripcion, at, preguntas, respuestas: [], lastActivity: Date.now(), batch: esMultiple };
  sessions.set(ctx.chat.id, session);
  const n = preguntas.length; // 0-3 now, not always 3 (shared across all meals when batch)
  await ctx.reply(`🍽️ ${descripcion}\n\nTe hago ${n} pregunta${n > 1 ? 's' : ''} para afinar el cálculo (/cancelar para salir).`);
  await ctx.reply(question(session));
}

const question = ({ preguntas, respuestas }) => `${respuestas.length + 1}/${preguntas.length}: ${preguntas[respuestas.length]}`;

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
