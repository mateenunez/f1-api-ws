import express from "express";
import { AxiosResponse } from "axios";
import cors from "cors";
import http from "http";
import { HubConnection } from "@microsoft/signalr";
import WebSocketServer from "./websocketServer";
import WebSocketClient from "./websocketClient";
import router from "./api";
import dotenv from "dotenv";
dotenv.config()

const app = express();
const server = http.createServer(app);
const PORT = 4000;

const maxAttempts = 2;
var attempts = 0;

app.use(cors());

app.use("/", router);

const websocketClient = new WebSocketClient(); // Realiza la conexión al WebSocket F1 y es el event bus.

const websocketServer = new WebSocketServer(server, websocketClient); // Maneja las conexiones de los clientes y escucha el event bus.

server.listen(PORT, () => {
  console.log("Server listening in port: " + PORT);
});

async function main() {
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

main();