import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketTelemetryServer } from "./websocketServer";
import { F1APIWebSocketsClient } from "./websocketClient";
import { StateProcessor } from "./stateProcessor";
import { ReplayProvider } from "./replayProvider";
import router from "./api";
import dotenv from "dotenv";
import { EventEmitter } from "stream";
import { TranslationService } from "./translationService";
import { TranscriptionService } from "./transcriptionService";
dotenv.config()

async function main() {

  const app = express();
  const server = http.createServer(app);
  const PORT = 4000;

  app.use(cors());

  app.use("/", router);

  const translationService = new TranslationService(); // Service de traducción usando Gemini API.
  const transcriptionService = new TranscriptionService() // Service de transcripción usando AssemblyAI API.

  const stateProcessor = new StateProcessor(translationService); // Procesa y mantiene el estado de la sesión actual.

  let eventEmitter: EventEmitter;

  if (process.env.REPLAY_FILE) {
    const fastForwardSeconds = parseInt(process.env.REPLAY_FAST_FORWARD_SECONDS || "0");
    const replayProvider = new ReplayProvider(process.env.REPLAY_FILE, stateProcessor, fastForwardSeconds); // Reproduce un archivo de replay y actualiza el stateProcessor.
    eventEmitter = replayProvider;
    replayProvider.run();
  } else {
    const websocketClient = new F1APIWebSocketsClient(stateProcessor, translationService, transcriptionService); // Realiza la conexión al WebSocket F1 y es el event bus.
    websocketClient.init(); // async init
    eventEmitter = websocketClient;
  }

  new WebSocketTelemetryServer(server, stateProcessor, eventEmitter); // Maneja las conexiones de los clientes y escucha el event bus.

  server.listen(PORT, () => {
    console.log("Server listening in port: " + PORT);
  });

}

main();