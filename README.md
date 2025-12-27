[![en](https://img.shields.io/badge/lang-en-blue.svg)](https://github.com/mateenunez/f1-api-ws/blob/master/README.en.md)
[![es](https://img.shields.io/badge/lang-es-yellow.svg)](https://github.com/mateenunez/f1-api-ws/blob/master/README.md)
# f1-api-ws
##### Este backend se conecta a la fuente de datos y establece un Websocket que envía los datos en el formato apropiado para el consumo del [Frontend](https://github.com/mateenunez/f1-telemetry).

### 📦 Instalación

Recomiendo usar **pnpm** para la instalación de las dependencias y configurar las siguientes variables de entorno:

```
ASSEMBLYAI_API_KEY # Para transcripciones.
CALENDAR_URL # Archivo ICS.
GEMINI_API_KEY # Para traducciones.
REDISHOST
REDISPORT
LOCALHOST_WEBSOCKET # Simula la fuente de datos original, es un dev tool.
REPLAY_FILE # Replay file es un archivo JSON de una carrera para retransmitirla, es otro dev tool.
```

### 🎯 Parámetros

Ejecutar **pnpm run dev** o **pnpm run start** es suficiente para el funcionamiento normal. Como dev tools se crearon los siguientes parámetros:

```
--replay # Activa el modo replay.
--fast-forward=<x> # Adelanta x segundos.
--localws # Activa el websocket local.
```

### 📈 Uso responsable

Por favor, si querés permiso para usar esta API contactame antes de hacerlo para asegurar un uso correcto de los recursos ❤️.
