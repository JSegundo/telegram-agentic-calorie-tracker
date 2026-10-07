import { google } from 'googleapis';

// GOOGLE_SERVICE_ACCOUNT_JSON (inline JSON, for Railway) takes precedence; otherwise
// falls back to GOOGLE_APPLICATION_CREDENTIALS (file path, for local dev).
const auth = new google.auth.GoogleAuth({
  ...(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && { credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) }),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// Row: Fecha | Tipo | Descripción | Calorías | Proteína | Notas
// append is a single atomic API call (no read-then-write), so concurrent appends never overwrite each other.
export async function appendMeal(row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `'${process.env.SHEET_NAME}'!A:F`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

// backs claude.js's buscar_comida_habitual; only called on "lo de siempre", so a plain
// unindexed read is fine. Columns match appendMeal's row order.
export async function getRecentMeals(tipo, limit = 8) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `'${process.env.SHEET_NAME}'!A:F`,
  });
  return (data.values ?? [])
    .filter((row) => row[1] === tipo)
    .slice(-limit)
    .map(([fecha, , descripcion, calorias, proteina]) => ({ fecha, descripcion, calorias, proteina }));
}

// backs claude.js's consultar_historial; desde/hasta are YYYY-MM-DD, inclusive — string
// comparison works since appendMeal always writes ISO dates.
export async function getMealsInRange(desde, hasta) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `'${process.env.SHEET_NAME}'!A:F`,
  });
  return (data.values ?? [])
    .filter(([fecha]) => fecha >= desde && fecha <= hasta)
    .map(([fecha, tipo, descripcion, calorias, proteina]) => ({ fecha, tipo, descripcion, calorias: Number(calorias), proteina: Number(proteina) }));
}
