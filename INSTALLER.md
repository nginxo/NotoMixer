# Installer di NotoMixer

## macOS

Il pacchetto installa NotoMixer in `/Applications` e include FFmpeg e FFprobe per l'analisi audio e il supporto M4A. Servono macOS 12 o successivo e il pacchetto adatto al Mac.

- **arm64** per Apple Silicon, inclusi i Mac con macOS 27 Golden Gate.
- **x64** per Intel.

L'app crea `config.notomixer` e `settings/userSettings.notomixer` in `~/Library/Application Support/NotoMixer` al primo avvio. Questi file vengono conservati quando si installa una nuova versione.

### Compilazione

Su un Mac con Node.js 24 e gli strumenti da riga di comando di Xcode, esegui dalla cartella del progetto:

```sh
npm ci
npm run build:installer:mac
```

Il comando genera il `.pkg` della stessa architettura di Node in `dist/installer-mac/`. Per generare entrambe le versioni da GitHub, esegui il workflow **Installer macOS** e scarica i due pacchetti da **Artifacts**. Il workflow parte anche quando si pubblica un tag `v*`.

Il workflow compila il pacchetto arm64 su macOS 27 e verifica l'installazione, l'avvio del mixer e la decodifica M4A. La build Intel usa macOS 15.

La build predefinita genera un'app con firma ad hoc e un pacchetto privo di firma Developer ID. Per distribuire i pacchetti con firma e notarizzazione Apple, imposta le identità già installate nel portachiavi e il profilo di `notarytool` prima della build. [Guida Apple alla notarizzazione](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

```sh
export NOTOMIXER_MAC_APP_IDENTITY='Developer ID Application: …'
export NOTOMIXER_MAC_INSTALLER_IDENTITY='Developer ID Installer: …'
export NOTOMIXER_MAC_NOTARY_PROFILE='profilo-notarytool'
npm run build:installer:mac
```

## Windows

Da Windows, esegui `npm run build:installer` per generare il setup in `dist/installer/`.
