[![en](https://img.shields.io/badge/lang-en-blue.svg)](https://github.com/mateenunez/f1-api-ws/blob/master/README.en.md)
[![es](https://img.shields.io/badge/lang-es-yellow.svg)](https://github.com/mateenunez/f1-api-ws/blob/master/README.md)
# f1-api-ws
##### This backend connects to the data source and establishes a WebSocket that sends data in the appropriate format for consumption by the [Frontend](https://github.com/mateenunez/f1-telemetry).

### 📦 Installation

I recommend using **pnpm** to install dependencies. You will also need to configure the following environment variables:

```
ASSEMBLYAI_API_KEY # For transcriptions.
CALENDAR_URL # ICS file.
GEMINI_API_KEY # For translations.
REDISHOST
REDISPORT
LOCALHOST_WEBSOCKET # Simulates the original data source (dev tool).
REPLAY_FILE # A JSON file of a race for re-broadcasting (dev tool).
```

### 🎯 Parameters

Running **pnpm run dev** or **pnpm run start** is sufficient for normal operation. The following parameters were created as development tools:
```
--replay # Enables replay mode.
--fast-forward=<x> # Fast-forwards by x seconds.
--localws # Enables the local WebSocket.
```

### 📈 Responsible Use

If you would like permission to use this API, please contact me beforehand to ensure the correct use of resources ❤️.
