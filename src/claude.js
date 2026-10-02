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

const QUESTIONS = object({
  descripcion: str,
  pregunta_porciones: str,
  pregunta_coccion: str,
  pregunta_extras: str,
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

export async function analyzeMeal(meal) {
  const r = await ask(
    [
      ...mealContent(meal),
      {
        type: 'text',
        text: `Describí brevemente lo que ves y hacé exactamente 3 preguntas específicas a esta comida que más reduzcan la incertidumbre del cálculo:
1) porciones/cantidades, 2) método de cocción (aceite, manteca, frito, horno...), 3) ingredientes extras no visibles (salsas, aderezos, azúcar, bebida...).`,
      },
    ],
    QUESTIONS,
  );
  return { descripcion: r.descripcion, preguntas: [r.pregunta_porciones, r.pregunta_coccion, r.pregunta_extras] };
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
- tipo: según la hora y la comida.
- descripcion: corta, con cantidades (ej. "3 huevos fritos con pan").
- calorias: kcal totales; proteina: gramos totales (enteros).
- detalle: desglose breve por ingrediente para mostrarle al usuario.`,
      },
    ],
    RESULT,
  );
}
