import express from "express";
import { AxiosResponse } from "axios";
import cors from "cors";
import http from "http";
import { HubConnection } from "@microsoft/signalr";
import { WebSocketTelemetryServer } from "./websocketServer";
import { F1APIWebSocketsClient } from "./websocketClient";
import { StateProcessor } from "./stateProcessor";
import { ReplayProvider } from "./replayProvider";
import router from "./api";
import dotenv from "dotenv";
import { EventEmitter } from "stream";
dotenv.config()

async function main() {

  const app = express();
  const server = http.createServer(app);
  const PORT = 4000;

  const maxAttempts = 2;
  var attempts = 0;

  app.use(cors());

  app.use("/", router);

  const stateProcessor = new StateProcessor(); // Procesa y mantiene el estado de la sesión actual.

  let eventEmitter: EventEmitter;

  if (process.env.REPLAY_FILE) {
    const fastForwardSeconds = parseInt(process.env.REPLAY_FAST_FORWARD_SECONDS || "0");
    const replayProvider = new ReplayProvider(process.env.REPLAY_FILE, stateProcessor, fastForwardSeconds); // Reproduce un archivo de replay y actualiza el stateProcessor.
    eventEmitter = replayProvider;
    replayProvider.run();
  } else {
    const websocketClient = new F1APIWebSocketsClient(stateProcessor); // Realiza la conexión al WebSocket F1 y es el event bus.
    eventEmitter = websocketClient;
    try {
      const subscriptionToken = process.env.F1TVSUBSCRIPTION_TOKEN || "";

      let negotiation: AxiosResponse;
      let cookies: string[];

      try {
        negotiation = await websocketClient.premiumNegotiation(subscriptionToken);

        let sock: HubConnection;

        cookies = negotiation.headers["set-cookie"] ?? [];

        if (negotiation && negotiation.status === 200) {
          if (negotiation.headers)
            sock = await websocketClient.premiumWebsocketConnect(
              subscriptionToken,
              cookies
            );
          return;
        }
      } catch (premiumError) {
        console.warn("Premium connection failed: ", premiumError);
      }

      try {
        console.log("Started common negotiation.");

        const negotiationResponse = await websocketClient.commonNegotiation();

        const cookies: string[] = negotiationResponse.headers["set-cookie"] ?? [];

        const cookieString = cookies
          .map((cookie) => cookie.split(";")[0].trim())
          .join("; ");

        const sock = await websocketClient.commonWebSocketConnection(
          negotiationResponse.data["ConnectionToken"],
          cookieString
        );

        sock.send(
          JSON.stringify({
            H: "Streaming",
            M: "Subscribe",
            A: [
              [
                "Heartbeat",
                "CarData",
                "Position",
                "ExtrapolatedClock",
                "TopThree",
                "TimingStats",
                "TimingAppData",
                "WeatherData",
                "TrackStatus",
                "DriverList",
                "RaceControlMessages",
                "SessionInfo",
                "SessionData",
                "LapCount",
                "TimingData",
                "TyreStintSeries",
                "TeamRadio",
                "CarData.z",
                "Position.z",
              ],
            ],
            I: 1,
          })
        );
      } catch (commonError) {
        console.error("Common connection failed:", commonError);
      }
    } catch (error) {
      if (attempts < maxAttempts) {
        console.log("Attempting to reconnect...");
        const delay = Math.pow(2, attempts) * 1000
        setTimeout(() => {
          attempts++;
          main();
        }, delay);
      } else {
        console.log("Max reconnect attempts reached.", error);
      }
    }
  }

  new WebSocketTelemetryServer(server, stateProcessor, eventEmitter); // Maneja las conexiones de los clientes y escucha el event bus.

  server.listen(PORT, () => {
    console.log("Server listening in port: " + PORT);
  });

}

main();