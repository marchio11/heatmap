# 🔥 Heatmap

La mappa di calore della vita di tutti i giorni: le strade si illuminano tanto più quante più volte ci passi.

- Legge i file GPX di **GPSLogger** dalla cartella `GPSLogger` su Google Drive (oppure caricati a mano).
- Tutto avviene nel browser: i dati restano su Drive e in IndexedDB, nessun server.
- Statistiche per anno: km a piedi (camminata e corsa) e km con veicoli, riconosciuti dalla velocità.

## Pubblicazione

Sito statico senza build, pubblicato su Cloudflare Pages (`heatmap-marchio11.pages.dev`):
- Framework preset: *None*
- Build command: *(vuoto)*
- Build output directory: `/`

Il Client ID OAuth in `app.js` è pubblico per natura: funziona solo dalle origini autorizzate nella Google Cloud Console.
