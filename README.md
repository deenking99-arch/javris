# J.A.R.V.I.S. 2.0

Persönlicher Sprach-KI-Assistent mit holografischem Interface: Wake-Word „Jarvis“, natürliche deutsche Sprachkommunikation mit Unterbrechung, Claude als Gehirn, echte Werkzeuge (Dateien, Browser, Recherche, Kalender, Aufgaben, Gedächtnis, Automationen, MCP) und Hintergrund-Agenten, deren Arbeit du live mitverfolgst.

```
┌──────────────────────────── Browser (Interface) ─────────────────────────────┐
│ Reaktorkern (Three.js/GLSL) · HUD-Panels · Mikrofon (AudioWorklet, VAD)      │
│ Wake-Word: Porcupine (lokal)  ·  Wiedergabe-Queue + Spektrum                 │
└──────────────▲───────────────────────────── WebSocket ───────────────▲───────┘
               │ Zustände, Tools, Tasks, MCP, Metriken          PCM-Audio │ Sprache (MP3)
┌──────────────┴────────────────────────── Node.js-Server ────────────┴───────┐
│ Conversation-State-Machine ── Turn-Erkennung ── Barge-in ── Satz-Streaming   │
│ STT: Deepgram Streaming | Browser   ·   TTS: ElevenLabs | OpenAI | Browser   │
│ Claude-Agent (Streaming + Tools) ── Hintergrund-Agenten (bis zu 3 parallel)   │
│ Tools: Dateien · Browser (Playwright) · Web-Recherche · Kalender (ICS) ·      │
│        Aufgaben · Gedächtnis · Automationen · Shell · MCP-Server             │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Schnellstart

Voraussetzung: Node.js 20 oder neuer, Chrome oder Edge.

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
# .env öffnen und mindestens ANTHROPIC_API_KEY eintragen
npm run build
npm start
```

Dann **http://127.0.0.1:7777** öffnen, auf „System aktivieren“ klicken und „Jarvis, …“ sagen.
Zum Entwickeln mit Live-Reload: `npm run dev`.

## API-Schlüssel

| Variable | Pflicht | Wofür | Wo |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **ja** | Denken, Tools, Agenten, Websuche | console.anthropic.com → API Keys |
| `DEEPGRAM_API_KEY` | empfohlen | Schnelle deutsche Streaming-Spracherkennung | console.deepgram.com |
| `ELEVENLABS_API_KEY` | empfohlen | Natürliche, ruhige männliche Stimme | elevenlabs.io → Settings → API Keys |
| `PICOVOICE_ACCESS_KEY` | empfohlen | Wake-Word „Jarvis“ komplett lokal | console.picovoice.ai (kostenlos) |
| `OPENAI_API_KEY` | optional | Alternative Stimme („onyx“) | platform.openai.com |
| `JARVIS_CALENDAR_ICS` | optional | Termine für „Was steht heute an?“ | Google Kalender → Einstellungen → „Privatadresse im iCal-Format“ |

Ohne die optionalen Schlüssel läuft Jarvis trotzdem: Die Spracherkennung übernimmt dann Chrome/Edge (Web Speech API), die Sprachausgabe die Browser-Stimme (unter Edge z. B. „Conrad“). Das Wake-Word wird dann im Transkript erkannt.

Nach dem Eintragen des Picovoice-Keys einmalig: `npm run setup:wakeword` (lädt das Porcupine-Modell).
Für die Browsersteuerung: `npm run setup:browser`, oder in der `.env` `JARVIS_BROWSER_CHANNEL=chrome` setzen, um den installierten Chrome zu nutzen.

**Sicherheit:** Schlüssel stehen nur in `.env`. Die Datei ist in `.gitignore`, wird nie an den Browser gesendet und nie ins Gespräch übernommen. Integrationen referenzieren Schlüssel nur über `${ENV:NAME}`.

## Sprachsteuerung

- **Wake-Word:** „Jarvis“, z. B. „Jarvis, was steht heute an?“ oder „Good evening, Jarvis.“ Alternativ Leertaste oder Klick auf den Kern.
- **Folgefragen:** Nach jeder Antwort hört Jarvis 8 Sekunden ohne Wake-Word weiter zu (`JARVIS_FOLLOWUP_MS`).
- **Unterbrechen:** Einfach reinsprechen, oder „Stopp“ sagen bzw. Leertaste/Esc drücken. Jarvis senkt beim Sprechen sofort die Lautstärke, stoppt und hört zu. Ein Echo-Schutz verhindert, dass er sich selbst unterbricht.
- **Satzende:** Die Spracherkennung meldet Pausen. Endet ein Satz offen („… und“), wartet Jarvis länger.
- **Streaming:** Claude-Antworten werden satzweise vertont. Der erste Satz läuft, während der Rest noch generiert wird.
- **Bestätigungen:** Shell-Befehle, Löschen, Überschreiben und neue MCP-Server fragt Jarvis vorher an. Du antwortest per „Ja“/„Nein“ oder über die Buttons.

### Conversation-State-Machine

`IDLE → LISTENING → PROCESSING ⇄ EXECUTING → SPEAKING → LISTENING (Folgefrage) → IDLE`, dazu `INTERRUPTED` (Barge-in) und `ERROR`. Der Zustand wird serverseitig aus echten Signalen abgeleitet (Generierung läuft, Tool läuft, Audio spielt, Mikrofon offen) und steuert Reaktorkern und Anzeige.

### Datenschutz

- Mit Porcupine wird das Wake-Word **lokal im Browser** erkannt. Erst danach geht Audio an die Spracherkennung.
- Ohne Porcupine wird Audio nur bei lokal erkannter Sprache gesendet.
- Die Anzeige oben rechts zeigt immer an, ob Audio den Rechner verlässt (`AUDIO → STT`). Ein Klick darauf schaltet das Mikrofon aus.
- Es wird kein Audio gespeichert. Der Server ist nur lokal erreichbar (`127.0.0.1`) und lehnt Verbindungen fremder Webseiten ab.

## Aufgaben & Agenten

Längere Aufträge („recherchiere …“, „fasse mein letztes Projekt zusammen“, „richte eine MCP-Integration ein“) übergibt Jarvis an **Hintergrund-Agenten**. Das Gespräch geht währenddessen weiter. Im Panel „Agenten & Aufgaben“ siehst du Status, Fortschritt und verwendete Tools. Ergebnisse landen als Markdown in `~/Jarvis/Ergebnisse/`, und Jarvis sagt die Kurzfassung an, sobald er frei ist.

Automationen: „Jarvis, gib mir jeden Morgen um halb acht ein Briefing“ legt einen Cron-Job an. „Erinnere mich in 20 Minuten an …“ funktioniert ebenfalls.

## MCP-Integrationen

Konfiguration in `data/mcp.json` (Format wie Claude Desktop, Beispiel: `data/mcp.example.json`) oder per Sprache: „Jarvis, richte eine MCP-Integration für meinen Kalender ein.“ Jarvis recherchiert das passende Paket, fragt nach Bestätigung, verbindet den Server und sagt dir, welche Umgebungsvariable in die `.env` gehört. Status und laufende Aktionen jedes Servers stehen live im Panel „MCP-Verbindungen“.

## Autostart

- **Windows:** Verknüpfung zu `scripts\start-jarvis.bat` in den Autostart-Ordner legen (`Win+R` → `shell:startup`).
- **macOS:** `scripts/start-jarvis.sh` als Anmeldeobjekt hinzufügen.

Die Skripte öffnen Chrome im App-Modus mit erlaubter Audiowiedergabe. Hast du das Mikrofon einmal erlaubt, startet Jarvis ohne Klick und hört sofort auf „Jarvis“.

## Projektstruktur

```
server/
  index.js              HTTP/WebSocket, Verdrahtung
  config.js             Konfiguration aus .env
  core/                 State-Machine, Event-Bus, Bestätigungen, Speicher
  agent/                Claude-Agentenschleife, Gesprächssteuerung, Hintergrund-Agenten, Prompts
  voice/                Satz-Streaming, TTS-Provider, Deepgram-STT
  tools/                Dateien, Browser, System, Gedächtnis, Aufgaben, Kalender, Automationen
  mcp/manager.js        MCP-Client-Verwaltung
  system/metrics.js     Echte Systemtelemetrie
client/
  src/reactor/          Reaktorkern (Three.js, GLSL, Bloom)
  src/voice/            Mikrofon, Wake-Word, Wiedergabe, Browser-STT, Steuerung
  src/ui/hud.js         HUD-Panels
test/                   Unit- und Ende-zu-Ende-Tests (mit lokalem Claude-API-Mock)
```

## Tests

```bash
npm test
```

Die Ende-zu-Ende-Tests starten den echten Server gegen einen lokalen Mock der Claude-API und simulieren einen Browser. Abgedeckt sind: Wake-Word, Folgefragen mit Kontext, Barge-in mit Echo-Schutz, Tool-Ausführung, Hintergrund-Agenten, Sprachbestätigungen, echte MCP-Verbindung, Browsersteuerung, Origin-Schutz und das Verhalten, wenn die API einen Parameter ablehnt.

## Fehlerbehebung

- **„ANTHROPIC_API_KEY fehlt“:** Schlüssel in `.env` eintragen, Server neu starten.
- **Kein Mikrofon:** Schloss-Symbol in der Adressleiste → Mikrofon erlauben. Jarvis zeigt `MIC FEHLER` mit Grund an.
- **Wake-Word reagiert nicht:** Bei Porcupine `npm run setup:wakeword` ausführen und den Key prüfen. Sonst Chrome/Edge verwenden.
- **Browser-Tool:** `npm run setup:browser` oder `JARVIS_BROWSER_CHANNEL=chrome`.
- **Stimme klingt robotisch:** `ELEVENLABS_API_KEY` setzen. In den Einstellungen (Zahnrad) lassen sich Provider, Tempo und Lautstärke umstellen.
