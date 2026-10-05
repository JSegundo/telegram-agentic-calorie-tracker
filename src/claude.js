import Anthropic from '@anthropic-ai/sdk';
import { getRecentMeals } from './sheets.js';

const client = new Anthropic();

const SYSTEM = `Sos un nutricionista que estima calorías y proteína de comidas a partir de fotos y descripciones.
Respondé siempre en español rioplatense, breve y concreto.`;

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
const QUESTIONS = object({
  valido: { type: 'boolean' },
  descripcion: str,
  preguntas: { type: 'array', items: str },
});

// valido=false: nonsense/contradictory answer, descripcion holds the rejection message,
// numeric fields are unused filler. fecha: resolved date (handles "lo comí ayer" etc.),
// not just the message's send date.
const RESULT = object({
  valido: { type: 'boolean' },
  fecha: { type: 'string', format: 'date' },
  tipo: { type: 'string', enum: ['Desayuno', 'Almuerzo', 'Merienda', 'Cena', 'Snack'] },
  descripcion: str,
  calorias: int,
  proteina: int,
  detalle: str,
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
const TOOLS = [{
  name: 'buscar_comida_habitual',
  description: 'Busca las últimas comidas registradas de un tipo para ver qué cantidades se usaron habitualmente. Llamar SOLO si el usuario dice explícitamente algo como "lo de siempre", "como siempre", "igual que ayer/el otro día" o "lo habitual" — una referencia explícita a repetir una comida anterior. NO llamar para una comida nueva sin esa referencia explícita, y no llamar más de una vez por mensaje.',
  input_schema: object({ tipo: { type: 'string', enum: ['Desayuno', 'Almuerzo', 'Merienda', 'Cena', 'Snack'] } }),
}];

async function runTool(name, input) {
  if (name === 'buscar_comida_habitual') return getRecentMeals(input.tipo);
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
        text: `Hora local: ${now}. Si la foto o el texto NO corresponden a una comida real (objeto random, texto sin sentido, spam, etc.), poné valido=false, preguntas=[] y descripcion con una frase breve explicando por qué no se puede procesar.
Si sí es comida, poné valido=true, describí brevemente lo que ves, clasificá la comida y hacé hasta 3 preguntas (0 a 3), solo las necesarias para reducir la incertidumbre del cálculo:
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
  return { descripcion: r.descripcion, preguntas: r.preguntas, valido: r.valido };
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
