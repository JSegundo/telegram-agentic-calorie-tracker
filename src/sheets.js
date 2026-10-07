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

// Sheets auto-detects a typed-in date (e.g. a row added by hand, in whatever format the
// sheet's locale shows) and stores it as a date cell, not as our "Fecha" column's ISO text.
// UNFORMATTED_VALUE returns those as a serial day count instead of a locale-formatted
// string, so dates compare correctly regardless of how the row was entered.
async function getRows() {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `'${process.env.SHEET_NAME}'!A:F`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return (data.values ?? []).map((row) => [typeof row[0] === 'number' ? serialToISO(row[0]) : row[0], ...row.slice(1)]);
}

// Sheets' date serial: day 0 = 1899-12-30.
const serialToISO = (serial) => new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000).toISOString().slice(0, 10);

// backs claude.js's buscar_comida_habitual; only called on "lo de siempre", so a plain
// unindexed read is fine. Columns match appendMeal's row order.
export async function getRecentMeals(tipo, limit = 8) {
  const rows = await getRows();
  return rows
    .filter((row) => row[1] === tipo)
    .slice(-limit)
    .map(([fecha, , descripcion, calorias, proteina]) => ({ fecha, descripcion, calorias, proteina }));
}

// backs claude.js's consultar_historial; desde/hasta are YYYY-MM-DD, inclusive.
export async function getMealsInRange(desde, hasta) {
  const rows = await getRows();
  return rows
    .filter(([fecha]) => fecha >= desde && fecha <= hasta)
    .map(([fecha, tipo, descripcion, calorias, proteina]) => ({ fecha, tipo, descripcion, calorias, proteina }));
}
