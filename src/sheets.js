import { google } from 'googleapis';

// Credentials come from GOOGLE_APPLICATION_CREDENTIALS (service account key file).
const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
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
