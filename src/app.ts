import express from "express";
import cors from "cors";
import http from "http";
import { monitorEventLoopDelay } from "perf_hooks";
import { WebSocketTelemetryServer } from "./websocketServer";
import { F1APIWebSocketsClient } from "./websocketClient";
import { StateProcessor } from "./stateProcessor";
import { ReplayProvider } from "./replayProvider";
import dotenv from "dotenv";
import { EventEmitter } from "stream";
import { TranslationService } from "./translationService";
import { TranscriptionService } from "./transcriptionService";
import { RedisClient } from "./redisClient";
import { DatabaseService } from "./databaseService";
import createRouter from "./api";
import { UserService } from "./userService";
import { RoleService } from "./roleService";
import { ConfigService } from "./configService";
import { EmailService } from "./emailService";
dotenv.config();

async function main() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 4000;

  app.use(cors());
  app.use(express.json()); // <-- enable JSON body parsing
  // Trust the single reverse-proxy hop (nginx, see docker-compose.yml) so
  // req.ip reflects the real client IP from X-Forwarded-For instead of
  // nginx's own address — required for per-IP rate limiting to work.
  app.set("trust proxy", 1);

  // instantiate services used by the API
  const databaseService = new DatabaseService(); // PostgreSQL database for users.
  const translationService = new TranslationService(); // Translation service using Gemini API.
  const transcriptionService = new TranscriptionService(); // Transcription service using AssemblyAI API.
  const redisClient = new RedisClient(); // Redis client for storing and retrieving data.

  const stateProcessor = new StateProcessor(redisClient); // Processes and maintains the state of the current session.

  let eventEmitter: EventEmitter;
  const argvReplay = process.argv.some((arg) => arg === "--replay");
  console.log("Replay flag is set as", argvReplay);

  let websocketClient: F1APIWebSocketsClient | null = null;

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

    console.log("Fast forward is set to", fastForwardSeconds);

    const replayProvider = new ReplayProvider(
      process.env.REPLAY_FILE,
      stateProcessor,
      fastForwardSeconds,
    ); // Plays a replay file and updates the stateProcessor.
    eventEmitter = replayProvider;
    replayProvider.run();
  } else {
    websocketClient = new F1APIWebSocketsClient(
      stateProcessor,
      translationService,
      transcriptionService,
    ); // Connects to the F1 WebSocket and acts as the event bus.
    websocketClient.init(); // async init
    eventEmitter = websocketClient;
  }

  const userService = new UserService(databaseService.getPool(), redisClient);
  const roleService = new RoleService(databaseService.getPool());
  const configService = new ConfigService(databaseService.getPool());
  const emailService = new EmailService();

  // mount API router with injected services
  app.use(
    "/",
    createRouter(
      databaseService,
      redisClient,
      userService,
      roleService,
      configService,
      emailService,
      websocketClient,
    ),
  );

  const telemetryServer = new WebSocketTelemetryServer(
    server,
    stateProcessor,
    eventEmitter,
    redisClient,
    userService,
    roleService,
  ); // Handles client connections and listens to the event bus.

  if (eventEmitter instanceof F1APIWebSocketsClient) {
    (eventEmitter as any).setClientCountProvider(() =>
      telemetryServer.getClientCount(),
    );
  }

  // Cheap, always-on canary: correlates event-loop lag and CPU time against
  // connected client count so a synchronous bottleneck (e.g. per-client
  // CBOR encoding on broadcast) shows up before reaching for a profiler.
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  let lastCpuUsage = process.cpuUsage();

  setInterval(() => {
    const cpuDelta = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();

    console.log("[metrics]", {
      clients: telemetryServer.getClientCount(),
      evtLoopDelayP50Ms: (eventLoopDelay.percentile(50) / 1e6).toFixed(2),
      evtLoopDelayP99Ms: (eventLoopDelay.percentile(99) / 1e6).toFixed(2),
      evtLoopDelayMaxMs: (eventLoopDelay.max / 1e6).toFixed(2),
      cpuUserMs: (cpuDelta.user / 1000).toFixed(1),
      cpuSystemMs: (cpuDelta.system / 1000).toFixed(1),
    });

    eventLoopDelay.reset();
  }, 5000);

  server.listen(PORT, () => {
    console.log("Server listening on port: " + PORT);
  });
}

main();
