# NotoMixer Companion per ESP32-S3

Firmware Arduino per ESP32-S3 N16R8 e ILI9488 SPI. Mostra entrambe le deck con titolo, BPM, tempo, stato di riproduzione, una finestra scorrevole di 8 secondi e la panoramica del brano. Le waveform arrivano da NotoMixer attraverso la porta COM USB. Le ampiezze di bassi, medi e alti sono disegnate a strati in blu, arancio e avorio. La finestra scorrevole mostra la griglia dei beat e il numero di battuta. Hot cue e loop attivi sono visibili anche nella panoramica.

## Collegamenti

| Display | ESP32-S3 |
| --- | --- |
| VDD | 3V3, se previsto dal modulo |
| GND | GND |
| CS | GPIO 10 |
| RST | GPIO 9 |
| D/C | GPIO 8 |
| SDI / MOSI | GPIO 11 |
| SCK | GPIO 12 |
| SDO / MISO | GPIO 13, facoltativo per il display in sola scrittura |
| BL | GPIO 7, attivo HIGH sul modulo provato |

Il preset riproduce il cablaggio e l'accensione dello sketch provato. GPIO 7 viene tenuto a LOW durante l'inizializzazione del pannello e portato a HIGH subito dopo. Su un modulo diverso verifica i requisiti di VDD e BL. Tutte le impostazioni del display sono in [Config.h](NotoMixerCompanion/Config.h).

Il preset usa SPI2 in modalità 0 e rotazione 1 (480 × 320 in orizzontale). Usa rotazione 3 per girare lo schermo di 180° in orizzontale. Se il tuo modulo scambia rosso e blu, prova `DisplayBgr = true`. Se inverte chiaro e scuro, prova `DisplayInverted = true`.

## Primo avvio

1. In Arduino IDE installa il core **esp32 by Espressif Systems** e, dal Gestore librerie, **LovyanGFX**.
2. Apri [NotoMixerCompanion.ino](NotoMixerCompanion/NotoMixerCompanion.ino) e seleziona **ESP32S3 Dev Module** e la porta della scheda.
3. Imposta i valori qui sotto, compila e carica lo sketch. All'avvio appare il logo di NotoMixer. Il display torna al logo quando la connessione si chiude o smette di ricevere dati.

| Opzione Arduino IDE | Valore |
| --- | --- |
| CPU Frequency | 240 MHz |
| Flash Size | 16MB (128Mb) |
| Flash Mode | QIO 80MHz |
| PSRAM | OPI PSRAM |
| USB CDC On Boot | Enabled |
| USB Mode | Hardware CDC and JTAG |
| Upload Mode | UART0 / Hardware CDC |
| Upload Speed | 460800 se disponibile, altrimenti 115200 |
| Partition Scheme | Default 4MB with spiffs |

## Collegamento a NotoMixer

1. Collega l'ESP32 via USB e chiudi il Monitor seriale di Arduino IDE per liberare la porta COM.
2. Avvia la versione aggiornata di NotoMixer presente in questo repository. Usa il collegamento COM già presente nell'app. Su questo PC il bridge **CH343** è comparso come **COM5**.
3. Quando lo schermo mostra le deck A e B, carica un brano e prova play, pausa e un salto sulla timeline. I picchi compaiono quando l'analisi del brano li rende disponibili.

Il preset usa il bridge **CH343** su UART0 a **115200 baud**. Se colleghi invece la porta USB nativa dell'ESP32-S3, abilita **USB CDC On Boot** e imposta `CompanionUseNativeUsb = true` in `Config.h` prima di ricompilare.

## Browser dei brani

Con la companion collegata e la finestra di NotoMixer attiva, premi **Alt+B** per aprire la libreria sul display. Usa **↑ / ↓** per scegliere il brano, **1** o **2** per caricarlo sulla deck corrispondente ed **Esc** per tornare alle waveform. In alto compare `AVAILABLE SONGS (D:\)` con l'unità della libreria. Il contatore a destra mostra l'ultimo brano della pagina rispetto al totale, per esempio `8/42`. La lista mostra titolo, BPM e durata quando disponibili.

Per comandare lo stesso browser via COM, invia una riga `BROWSER:OPEN`, `BROWSER:UP`, `BROWSER:DOWN`, `BROWSER:LOAD1`, `BROWSER:LOAD2` o `BROWSER:CLOSE`. Il firmware inoltra l'azione a NotoMixer come `NM-BROWSER:<azione>`. I comandi inviati da un secondo programma richiedono un collegamento seriale che consenta lo scambio con NotoMixer, dato che l'app occupa la porta COM.

NotoMixer invia la pagina al display come `NM-LIBRARY:` seguito da Base64. I primi 12 byte contengono lo stato aperto, il numero di righe, la selezione nella pagina, un byte riservato, il totale e l'indice della prima riga. Totale e indice sono uint32 little-endian. Ogni riga contiene 80 byte di titolo UTF-8, BPM in decimi e durata in secondi, entrambi uint16 little-endian. Dalla versione 7 seguono 32 byte con l'unità della libreria in UTF-8 terminato da NUL.

## Protocollo

La companion si identifica con la riga `NM-COMPANION:7`. NotoMixer risponde con righe `NM-WAVEFORM:` seguite dai dati in Base64. Il pacchetto ha sigla `NM05`, due record di stato da 148 byte in ordine A, B e i picchi delle sole deck aggiornate. Gli aggiornamenti di posizione occupano 300 byte. Tutti i campi numerici multibyte sono little-endian. L'app accetta anche i firmware precedenti.

NotoMixer invia i picchi quando la companion si identifica o quando cambiano. Invia una sola waveform per pacchetto, fino a 6000 campioni. Durante il caricamento può svuotare una deck con il solo record di stato.

| Offset nel record | Campo |
| --- | --- |
| 0 | Flag. Bit 0 brano caricato, bit 1 riproduzione, bit 2 picchi a tre bande, bit 3 loop attivo, bit 4 sostituzione dei picchi, bit 5 avviso di fine brano, bit 6 conto alla rovescia EndSync sulla deck entrante, bit 7 transizione EndSync in corso sulla deck uscente |
| 1 | Riservato |
| 2 | Numero di picchi, uint16 da 0 a 6000 |
| 4, 8, 12, 16 | Posizione in secondi, durata in secondi, velocità di avanzamento, BPM. Quattro float32 |
| 20 | Titolo UTF-8, 80 byte con terminazione NUL |
| 100, 104, 108, 112 | BPM sorgente, offset della griglia, inizio e fine del loop. Quattro float32 |
| 116 | Otto tempi hot cue come float32. -1 indica un cue assente |

Dopo i due record arrivano i picchi delle deck con bit 4 attivo. Con il bit 2 attivo ogni campione contiene tre ampiezze in un uint16: bassi nei bit 11–15, medi nei bit 5–10 e alti nei bit 0–4. Per l'inviluppo in attesa dell'analisi o per l'audio di test si usa un byte per campione.
