# Rombo — motore virtuale per Tesla

Rombo è una pagina web che simula il suono di un motore a combustione dagli altoparlanti dell'auto.
Il suono segue la velocità e l'accelerazione misurate dal GPS. È un progetto originale, ispirato all'idea di app come Rupteur.

## Uso
1. Apri l'indirizzo HTTPS nel browser della Tesla.
2. Tocca **AVVIA MOTORE**. L'audio parte solo dopo un tocco.
3. Scegli il motore: 6 in linea Biturbo (predefinito, carattere tipo Supra MK4 3.0 biturbo sequenziale), 4 cilindri Turbo, 5 cilindri, 6 Boxer aspirato oppure V8 albero a croce.
4. Scegli il cambio: Comfort, Dynamic o Manuale.
5. Imposta la valvola di scarico e il volume.
6. Come sorgente scegli **GPS (guida)** per l'uso in auto, oppure **Simulazione** per provare da fermo. In simulazione ci sono i pulsanti GAS e FRENO e i tasti W/S.
7. Per cambiare marcia usa **MARCIA + / −**, oppure i tasti ↑/↓, Invio, PagSu/PagGiù e +/−.
   Funzionano anche i tasti multimediali traccia successiva/precedente, quando l'opzione "sessione multimediale" è attiva.
   In Comfort o Dynamic, il primo cambio manuale passa automaticamente alla modalità Manuale.
8. In **Altre impostazioni** trovi: la sensibilità del carico GPS, il suono ibrido sperimentale con registrazioni CC0 (solo 4 cilindri) e le opzioni multimediali.

Serve **HTTPS** perché il browser conceda la geolocalizzazione e il service worker. In locale invece basta un server statico:

    python3 -m http.server 8000   # poi apri http://localhost:8000

## Struttura
- `engine-core.js`: la sintesi. Riproduce ogni scoppio in base all'angolo di manovella, con collettori e scarico a guida d'onda, marmitta e valvola, aspirazione, rumori meccanici, turbo/blow-off e scoppiettii in rilascio. Contiene anche il layer di campioni.
- `engine-worklet.js`: l'AudioWorklet. `app.js` ripiega su ScriptProcessor se il worklet non è disponibile.
- `drivetrain.js`: cambio, punti di cambiata in base al carico, frizione, limitatore e fisica della modalità simulazione.
- `presets.js`: i quattro motori.
- `tools/render.mjs`: genera offline i WAV di prova in `samples/` con `node tools/render.mjs`. `tools/analyze.py` ne misura picchi, RMS e clipping.
- `sw.js` e `manifest.webmanifest`: funzionamento offline e installazione come app.

`samples/`, `tools/` e `screenshot.png` non servono per la pubblicazione.
