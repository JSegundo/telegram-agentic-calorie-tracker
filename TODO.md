# Feature ideas (not implemented yet)

## Quick wins

- **`/hoy` and `/semana`** — read back from the sheet, sum calories/protein for
  today/this week, reply with totals. Right now the only way to see a running
  total is opening the spreadsheet.
- **`/deshacer`** — delete the last appended row. A bad entry currently has no
  fix except editing the sheet by hand.
- **Daily goal + remaining count** — store a calorie/protein target, include
  "quedan 450 kcal hoy" in the `✅ Guardado` reply.

## Same-as-usual shortcut

If a new meal's description matches a recent entry closely (e.g. the same
protein shake every morning), skip the questions and reuse the last answers
instead of asking again.

## Weekly summary chart

Generated image (calories/protein per day) sent on a schedule, instead of a
text dump.
