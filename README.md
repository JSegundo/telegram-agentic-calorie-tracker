# telegram-agentic-calorie-tracker
A Telegram bot that accepts photos or descriptions of the foods I eat, asks some questions to calculate the exact amount of calories and proteins in each food, and uploads them to a sheet where I can calculate the sum of it weekly and monthly

## Flujo
1. Mandás una foto (con descripción opcional en el caption) o solo un texto.
2. Claude analiza la comida y hace 3 preguntas: porciones, método de cocción e ingredientes extras.
3. Respondés cada pregunta (`/cancelar` para salir).
4. El bot calcula calorías y proteína y agrega una fila al Sheet:
   `Fecha | Tipo | Descripción | Calorías | Proteína | Notas`

## Estructura
```
src/bot.js     Telegram: sesiones por chat y flujo de preguntas
src/claude.js  Claude Vision: preguntas + cálculo final (JSON estructurado)
src/sheets.js  Google Sheets: append de la fila
```

## Setup
1. `npm install`
2. Bot de Telegram: crealo con [@BotFather](https://t.me/BotFather). Tu user id lo da [@userinfobot](https://t.me/userinfobot).
3. Google Sheets: en Google Cloud creá una service account, habilitá la Google Sheets API, descargá la key JSON como `service-account.json` y compartí el Sheet con el email de la service account como Editor.
4. `cp .env.example .env` y completá los valores.
5. `npm start`

Desactivá el Apps Script con trigger `onEdit`: ahora el bot escribe las filas directamente.
