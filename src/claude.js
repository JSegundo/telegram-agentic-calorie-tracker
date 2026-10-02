import Anthropic from '@anthropic-ai/sdk';

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

// Was 3 fixed fields (porciones/coccion/extras) asked for every meal, even simple ones
// where most don't apply. Now Claude picks 1-3 questions based on what the meal actually
// needs. `preguntas` feeds bot.js's session loop (session.preguntas.length drives the
// "n/total" counter and when calculateMeal() gets called), so its length must match however
// many questions Claude actually asked.
const QUESTIONS = object({
  descripcion: str,
  preguntas: { type: 'array', items: str },
});

const RESULT = object({
  tipo: { type: 'string', enum: ['Desayuno', 'Almuerzo', 'Merienda', 'Cena', 'Snack'] },
  descripcion: str,
  calorias: int,
  proteina: int,
  detalle: str,
});

async function ask(content, schema) {
  const res = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });
  if (res.stop_reason !== 'end_turn') throw new Error(`Claude stopped: ${res.stop_reason}`);
  return JSON.parse(res.content.find((b) => b.type === 'text').text);
}

// meal = { image?: base64 JPEG, text?: string }
function mealContent({ image, text }) {
  return [
    ...(image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }] : []),
    { type: 'text', text: `Comida: ${text || '(sin descripción, solo foto)'}` },
  ];
}

export async function analyzeMeal(meal, now) {
  // `now` lets Claude notice when the meal type (desayuno/almuerzo/merienda/cena/snack) is
  // ambiguous from the hour alone (e.g. 11:30am) and ask about it as one of the up-to-3
  // questions, instead of calculateMeal() silently guessing it later with no user input.
  const r = await ask(
    [
      ...mealContent(meal),
      {
        type: 'text',
        text: `Hora local: ${now}. Describí brevemente lo que ves. Clasificá la comida y hacé entre 1 y 3 preguntas (nunca más de 3), solo las necesarias para reducir la incertidumbre del cálculo:
- Mezcla simple sin cocción (ej. avena + manteca de maní + miel): una pregunta confirmando cantidades/proporciones.
- Proteína cocinada (ej. pollo, carne): peso aproximado, método de cocción (frito, plancha, horno) y si llevó aceite/manteca.
- Múltiples componentes (ej. arroz + carne + verduras): porciones y preparación de cada componente.
- Si la hora no deja claro si es desayuno, almuerzo, merienda, cena o snack, sumá una pregunta para confirmarlo.
No preguntes algo que ya es evidente en la foto o la descripción.`,
      },
    ],
    QUESTIONS,
  );
  return { descripcion: r.descripcion, preguntas: r.preguntas };
}

export async function calculateMeal(meal, preguntas, respuestas, now) {
  const qa = preguntas.map((q, i) => `P: ${q}\nR: ${respuestas[i]}`).join('\n\n');
  return ask(
    [
      ...mealContent(meal),
      {
        type: 'text',
        text: `${qa}

Hora local: ${now}. Con estas respuestas calculá los totales.
- tipo: si alguna respuesta confirma el tipo de comida, usá esa; si no, inferilo de la hora y la comida.
- descripcion: corta, con cantidades (ej. "3 huevos fritos con pan").
- calorias: kcal totales; proteina: gramos totales (enteros).
- detalle: desglose breve por ingrediente para mostrarle al usuario.`,
      },
    ],
    RESULT,
  );
}
