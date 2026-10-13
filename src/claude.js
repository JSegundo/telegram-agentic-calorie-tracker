import Anthropic from '@anthropic-ai/sdk';
import { getRecentMeals, getMealsInRange, updateMeal } from './sheets.js';

const client = new Anthropic();

const SYSTEM = `Sos un nutricionista que estima calorías y proteína de comidas a partir de fotos y descripciones.
Respondé siempre en español rioplatense, breve y concreto.
Objetivo del usuario: está en volumen y quiere comer AL MENOS 3200 kcal por día; superarlo es bueno.
Cuando hables del progreso del día, decí cuánto le falta para llegar al mínimo y sugerí cómo completarlo. Nunca le recomiendes comer menos, comer liviano ni "no pasarse".`;

const str = { type: 'string' };
const int = { type: 'integer' };
const object = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

// preguntas: 0-3 contextual questions (bot.js reads .length for the "n/total" counter).
// valido=false: non-food input, descripcion holds the rejection message, preguntas=[].
// es_consulta=true: history query or correction, already handled via tools; descripcion holds the reply,
// valido/preguntas are unused filler then.
// es_multiple=true: text describes 2+ meals in one message (a day backfill) — preguntas is
// still 0-3 but shared across all of them, not per meal; bot.js routes to calculateMeals().
const QUESTIONS = object({
  valido: { type: 'boolean' },
  es_consulta: { type: 'boolean' },
  es_multiple: { type: 'boolean' },
  descripcion: str,
  preguntas: { type: 'array', items: str },
});

// Shared by RESULT (one meal) and BATCH_RESULT's `comidas` items (several meals from one
// backfill message) — same per-meal fields either way.
const MEAL_FIELDS = {
  fecha: { type: 'string', format: 'date' },
  tipo: { type: 'string', enum: ['Desayuno', 'Almuerzo', 'Merienda', 'Cena', 'Snack'] },
  descripcion: str,
  calorias: int,
  proteina: int,
  detalle: str,
};

// valido=false: nonsense/contradictory answer, descripcion holds the rejection message,
// numeric fields are unused filler. fecha: resolved date (handles "lo comí ayer" etc.),
// not just the message's send date.
const RESULT = object({ valido: { type: 'boolean' }, ...MEAL_FIELDS });

// valido=false: comidas=[] filler, same meaning as RESULT's valido=false.
const BATCH_RESULT = object({
  valido: { type: 'boolean' },
  comidas: { type: 'array', items: object(MEAL_FIELDS) },
});

// tools/runTool only passed by analyzeMeal (buscar_comida_habitual); calculateMeal never loops here.
async function ask(content, schema, { tools, runTool } = {}) {
  const messages = [{ role: 'user', content }];
  for (;;) {
    const res = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema } },
      system: SYSTEM,
      ...(tools && { tools }),
      messages,
    });
    if (res.stop_reason === 'tool_use') {
      // push full assistant content + answer all tool_use blocks in one message (parallel calls allowed)
      messages.push({ role: 'assistant', content: res.content });
      const results = await Promise.all(
        res.content
          .filter((b) => b.type === 'tool_use')
          .map(async (b) => ({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(await runTool(b.name, b.input)) })),
      );
      messages.push({ role: 'user', content: results });
      continue;
    }
    if (res.stop_reason !== 'end_turn') {
      // tagged for bot.js's error middleware; raw stop_reason isn't user-facing
      const err = new Error(`Claude stopped: ${res.stop_reason}`);
      err.userMessage = '⚠️ Claude no pudo procesar eso. Probá de nuevo.';
      throw err;
    }
    return JSON.parse(res.content.find((b) => b.type === 'text').text);
  }
}

// Only called when the user explicitly says "lo de siempre"/equivalent — the description
// below is the actual trigger rule Claude reads.
const TOOLS = [
  {
    name: 'buscar_comida_habitual',
    description: 'Busca las últimas comidas registradas de un tipo para ver qué cantidades se usaron habitualmente. Llamar SOLO si el usuario dice explícitamente algo como "lo de siempre", "como siempre", "igual que ayer/el otro día" o "lo habitual" — una referencia explícita a repetir una comida anterior. NO llamar para una comida nueva sin esa referencia explícita, y no llamar más de una vez por mensaje.',
    input_schema: object({ tipo: { type: 'string', enum: ['Desayuno', 'Almuerzo', 'Merienda', 'Cena', 'Snack'] } }),
  },
  {
    name: 'consultar_historial',
    description: 'Busca las comidas registradas entre dos fechas (inclusive) para responder preguntas sobre el historial, ej. "cómo estuvo ayer", "qué comí la semana pasada", "cuánta proteína llevo esta semana". Llamar cuando el texto es una pregunta sobre comidas pasadas, no una comida nueva para registrar. desde/hasta en formato YYYY-MM-DD, resueltos a partir de la Hora local (ej. "ayer" = ese único día; "la semana pasada" = lunes a domingo anterior).',
    input_schema: object({ desde: { type: 'string', format: 'date' }, hasta: { type: 'string', format: 'date' } }),
  },
  {
    name: 'corregir_comida',
    description: 'Corrige una comida ya registrada, reemplazando fecha, tipo, descripción, calorías y proteína de esa fila. Llamar SOLO cuando el usuario pide corregir/cambiar una comida ya guardada, después de ubicarla con consultar_historial. fila y descripcion_actual: copiados exactos del resultado de consultar_historial. El resto: los valores finales completos (corregidos y recalculados), no solo lo que cambió.',
    strict: true,
    input_schema: object({
      fila: int,
      descripcion_actual: str,
      fecha: { type: 'string', format: 'date' },
      tipo: MEAL_FIELDS.tipo,
      descripcion: str,
      calorias: int,
      proteina: int,
    }),
  },
];

async function runTool(name, input) {
  if (name === 'buscar_comida_habitual') return getRecentMeals(input.tipo);
  if (name === 'consultar_historial') return getMealsInRange(input.desde, input.hasta);
  if (name === 'corregir_comida') {
    const { fila, descripcion_actual, fecha, tipo, descripcion, calorias, proteina } = input;
    return updateMeal(fila, descripcion_actual, [fecha, tipo, descripcion, calorias, proteina]);
  }
  throw new Error(`unknown tool ${name}`);
}

// meal = { image?: base64 JPEG, text?: string }
function mealContent({ image, text }) {
  return [
    ...(image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }] : []),
    { type: 'text', text: `Comida: ${text || '(sin descripción, solo foto)'}` },
  ];
}

export async function analyzeMeal(meal, now) {
  const r = await ask(
    [
      ...mealContent(meal),
      {
        type: 'text',
        text: `Hora local: ${now}. Si el texto es una pregunta sobre el historial de comidas (ej. "cómo estuvo ayer", "qué tal la semana pasada", "cuánta proteína llevo hoy") y no una comida nueva para registrar: poné es_consulta=true, valido=true, es_multiple=false, preguntas=[], usá consultar_historial con el rango de fechas correspondiente, y en descripcion escribí la respuesta completa en tono de nutricionista (breve, con los totales reales y algún comentario útil).
Si el texto pide corregir una comida ya registrada (ej. "corregí el desayuno de hoy, eran 2 huevos no 3", "el almuerzo de ayer tenía 700 kcal"): poné es_consulta=true, valido=true, es_multiple=false, preguntas=[]; ubicá la fila con consultar_historial, recalculá los totales con la corrección y guardalos con corregir_comida. En descripcion contá qué cambiaste (antes → después, con kcal y proteína). Si no queda claro qué comida es o qué cambiar, no llames corregir_comida: en descripcion pedí que lo reenvíe en un solo mensaje con ese dato.
Si el texto describe 2 o más comidas distintas en un mismo mensaje (ej. "ayer desayuné tostadas, almorcé pollo y cené ensalada", un repaso de todo un día): poné es_multiple=true, valido=true, es_consulta=false, descripcion con un resumen breve de las comidas que detectaste, y hacé hasta 3 preguntas EN TOTAL (0 a 3, no por comida) — solo las imprescindibles para calcular todas.
Si la foto o el texto NO corresponden a una comida real ni a una consulta (objeto random, texto sin sentido, spam, etc.), poné es_consulta=false, es_multiple=false, valido=false, preguntas=[] y descripcion con una frase breve explicando por qué no se puede procesar.
Si sí es una sola comida nueva para registrar, poné es_consulta=false, es_multiple=false, valido=true, describí brevemente lo que ves, clasificá la comida y hacé hasta 3 preguntas (0 a 3), solo las necesarias para reducir la incertidumbre del cálculo:
- Mezcla simple sin cocción (ej. avena + manteca de maní + miel): una pregunta confirmando cantidades/proporciones.
- Proteína cocinada (ej. pollo, carne): peso aproximado, método de cocción (frito, plancha, horno) y si llevó aceite/manteca.
- Múltiples componentes (ej. arroz + carne + verduras): porciones y preparación de cada componente.
- Si la hora no deja claro si es desayuno, almuerzo, merienda, cena o snack, sumá una pregunta para confirmarlo.
- Si la comida es simple y estándar (ej. una banana, una manzana, un café con leche, un yogurt sin agregados) y podés estimar razonablemente sin arriesgar mucho el cálculo, no preguntes nada: dejá preguntas=[] y asumí cantidades estándar.
No preguntes algo que ya es evidente en la foto o la descripción.
Si el usuario pide "lo de siempre" o algo equivalente, usá buscar_comida_habitual para ver las cantidades habituales de ese tipo de comida y hacé la pregunta mostrando ese valor como default (ej. "¿Cuántas fetas de bacon? Lo usual: 2") en vez de preguntar en blanco. Si no hay historial, preguntá normalmente.`,
      },
    ],
    QUESTIONS,
    { tools: TOOLS, runTool },
  );
  return { descripcion: r.descripcion, preguntas: r.preguntas, valido: r.valido, esConsulta: r.es_consulta, esMultiple: r.es_multiple };
}

// Batch counterpart of calculateMeal: takes the original backfill text (not split up front —
// Claude both re-identifies the individual meals and computes each one's totals here) plus
// the up-to-3 shared answers, and returns one result per meal it finds.
export async function calculateMeals(text, preguntas, respuestas, now) {
  const qa = preguntas.map((q, i) => `P: ${q}\nR: ${respuestas[i]}`).join('\n\n');
  return ask(
    [
      { type: 'text', text: `Comidas: ${text}` },
      {
        type: 'text',
        text: `${qa}

Hora local: ${now}. El texto describe varias comidas en un mismo mensaje, posiblemente de un día distinto a hoy (ej. "ayer"). Identificá cada comida por separado y calculá sus totales.
Si alguna respuesta no tiene sentido, poné valido=false y comidas=[] (no se van a usar).
Si tiene sentido (o no hay preguntas/respuestas), poné valido=true y para cada comida que identifiques:
- fecha: la fecha real en que se comió, en formato YYYY-MM-DD, resuelta a partir de la Hora local y cualquier referencia temporal del texto (ej. "ayer"). Si varias comidas son del mismo día, repetí la misma fecha.
- tipo, descripcion, calorias, proteina, detalle: igual que para una comida individual.`,
      },
    ],
    BATCH_RESULT,
  );
}

export async function calculateMeal(meal, preguntas, respuestas, now) {
  const qa = preguntas.map((q, i) => `P: ${q}\nR: ${respuestas[i]}`).join('\n\n');
  return ask(
    [
      ...mealContent(meal),
      {
        type: 'text',
        text: `${qa}

Hora local: ${now}. Si no hay preguntas ni respuestas arriba, es porque ya decidiste que la comida era simple/estándar — calculá directamente con cantidades estándar razonables para lo que ves.
Si alguna respuesta no tiene sentido para la pregunta que se hizo (no responde lo que se pidió, es contradictoria, es texto random), poné valido=false, descripcion con una frase breve explicando qué respuesta no se entendió, fecha igual a la fecha de hoy (la de "Hora local"), y dejá tipo="Snack", calorias=0, proteina=0, detalle="" (no se van a usar).
Si las respuestas tienen sentido (o no hay ninguna), poné valido=true y calculá los totales:
- fecha: la fecha real en que se comió esto, en formato YYYY-MM-DD. Si la foto, el texto o alguna respuesta menciona una referencia temporal (ej. "ayer", "anteayer", "el lunes pasado", una fecha concreta), calculala a partir de la fecha de hoy (la de "Hora local"). Si no menciona nada, usá la fecha de hoy tal cual.
- tipo: si alguna respuesta confirma el tipo de comida, usá esa; si no, inferilo de la hora y la comida.
- descripcion: corta, con cantidades (ej. "3 huevos fritos con pan").
- calorias: kcal totales; proteina: gramos totales (enteros).
- detalle: desglose breve por ingrediente para mostrarle al usuario.`,
      },
    ],
    RESULT,
  );
}
