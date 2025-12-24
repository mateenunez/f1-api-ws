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
import { RedisClient } from "./redisClient";
dotenv.config();

async function main() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 4000;

  app.use(cors());

  app.use("/", router);

  const translationService = new TranslationService(); // Translation service using Gemini API.
  const transcriptionService = new TranscriptionService(); // Transcription service using AssemblyAI API.
  const redisClient = new RedisClient(); // Redis client for storing and retrieving data.

  const stateProcessor = new StateProcessor(redisClient); // Processes and maintains the state of the current session.

  let eventEmitter: EventEmitter;
  const argvReplay = process.argv.some((arg) => arg === "--replay");
  console.log("Replay flag is set as", argvReplay)

  if (process.env.REPLAY_FILE && argvReplay) {
    let fastForwardSeconds = 0;

    // support --fast-forward=1080 or --fast-forward 1080
    const ffEq = process.argv.find((a) => a.startsWith("--fast-forward="));
    if (ffEq) {
      const maybe = ffEq.split("=")[1];
      const v = parseInt(maybe ?? "");
      if (!isNaN(v)) fastForwardSeconds = v;
    } else {
      const ffIdx = process.argv.indexOf("--fast-forward");
      if (ffIdx !== -1 && process.argv[ffIdx + 1]) {
        const v = parseInt(process.argv[ffIdx + 1]);
        if (!isNaN(v)) fastForwardSeconds = v;
      }
    }

    console.log("Fast forward is set to", fastForwardSeconds)

    const replayProvider = new ReplayProvider(
      process.env.REPLAY_FILE,
      stateProcessor,
      fastForwardSeconds
    ); // Plays a replay file and updates the stateProcessor.
    eventEmitter = replayProvider;
    replayProvider.run();
  } else {
    const websocketClient = new F1APIWebSocketsClient(
      stateProcessor,
      translationService,
      transcriptionService
    ); // Connects to the F1 WebSocket and acts as the event bus.
    websocketClient.init(); // async init
    eventEmitter = websocketClient;
  }

  new WebSocketTelemetryServer(server, stateProcessor, eventEmitter); // Handles client connections and listens to the event bus.

  server.listen(PORT, () => {
    console.log("Server listening on port: " + PORT);
  });
}

main();
