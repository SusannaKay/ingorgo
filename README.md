# Ingorgo! 🚌

Puzzle "bus jam" per browser mobile: tocca un bus per farlo uscire dal parcheggio seguendo la freccia, i passeggeri in coda salgono solo sul bus del loro colore. Se gli stalli d'attesa si riempiono e nessun bus va bene per chi è in testa alla coda, hai perso.

Vite + TypeScript, Canvas 2D, nessuna dipendenza a runtime (~11 kB gzip).

## Comandi

```bash
npm install
npm run dev            # server di sviluppo (raggiungibile anche dal telefono in LAN)
npm run build          # build in dist/
npm run check-levels -- 200   # genera e verifica i livelli 1..200
```

## Deploy su Vercel

Importa il repository su Vercel: riconosce Vite da solo (build `npm run build`, output `dist`). Oppure da terminale:

```bash
npx vercel --prod
```

## Parametri utili nell'URL

- `?level=42` apre un livello specifico (anche toccando "Livello N" in alto)
- `?debug=1` mostra le statistiche del livello (difficoltà, % vittorie stimata, catena di blocchi)

## Struttura

```
src/game/types.ts      tipi, celle, strade d'uscita
src/game/engine.ts     logica pura: tocco, imbarco, vittoria/sconfitta, +1 posto
src/game/generator.ts  generatore di livelli e curva di difficoltà
src/game/solver.ts     solver DFS (usato per il pulsante Aiuto e per le verifiche)
src/render/camera.ts   proiezione finto 3D (yaw, inclinazione, altezza)
src/render/scene.ts    animazioni a timeline e disegno
src/main.ts            interfaccia, input, overlay
scripts/check-levels.ts  verifica dei livelli
```

## Come vengono generati i livelli

1. **Piazzamento inverso.** I bus si piazzano uno alla volta e ognuno deve avere la strada libera rispetto a quelli già piazzati (ma può bloccarli). Così l'ordine inverso di piazzamento è sempre un'uscita valida: niente incastri circolari.
2. **Coda costruita da una soluzione.** Si sceglie un ordine d'uscita compatibile con i blocchi e si simula, generando i passeggeri in modo che al massimo `maxOcc` stalli siano occupati. Il livello è risolvibile per costruzione.
3. **Selezione per difficoltà percepita.** Per ogni livello si generano 18 candidati e si fanno giocare 80 partite a un giocatore simulato "ragionevole ma distratto". Si tiene il candidato con la % di vittorie più vicina all'obiettivo del livello.

La curva (`difficultyForLevel`) sale in modo esponenziale smorzato con un dente di sega su blocchi di 10: salita, livello "respiro", boss al decimo. Tutto è deterministico: il seed è il numero del livello, quindi lo stesso livello è identico su ogni dispositivo senza salvare nulla.

Manopole in `paramsForLevel`: dimensione griglia, numero di bus, colori, stalli (5, poi 4), quota di bus lunghi, quanto il piazzamento cerca blocchi, quanto la coda "va contro" l'ordine naturale d'uscita, % di vittorie obiettivo.

## Vista

In `src/render/camera.ts`: `yaw` ruota la scena (0 = vista frontale 3/4 come l'originale, valori più alti = più isometrico), `squash` è l'inclinazione della camera, `zk` l'altezza dei bus.

## Idee per i prossimi passi

- Meccaniche nuove ogni ~10 livelli: bus chiusi a chiave, colore nascosto "?", ambulanza a mosse limitate, timer.
- Suoni e vibrazione più ricca, monete e boost a pagamento.
- Coda dei bus in attesa sulla strada (ora possono sovrapporsi se tocchi molto in fretta).
- Service worker per giocare offline.
