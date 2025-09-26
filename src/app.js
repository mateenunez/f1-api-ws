const express = require("express");
const cors = require("cors");
const http = require("http");
const { router } = require("./api");
const WebSocketServer = require("./websocketServer");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const PORT = 4000;

app.use(cors());

app.use("/", router);

const websocketServer = new WebSocketServer(server);

server.listen(PORT, () => {
  console.log("Server listening in port: " + PORT);
});

async function main() {
  try {
    const subscriptionToken = process.env.F1TVSUBSCRIPTION_TOKEN;
    let negotiation, sock;
    try {
      negotiation = await websocketServer.premiumNegotiation(subscriptionToken);
      if (negotiation && negotiation.status === 200) {
        sock = await websocketServer.premiumWebsocketConnect(
          subscriptionToken,
          negotiation.headers["set-cookie"]
        );
        return;
      }
    } catch (premiumError) {
      console.warn("Premium connection failed: ", premiumError);
    }

    try {
      console.log("Started common negotiation");
      negotiation = await websocketServer.commonNegotiation();
      sock = await websocketServer.websocketConnect(
        negotiation.data["ConnectionToken"],
        negotiation.headers["set-cookie"]
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
      console.error("Common connection failed:", error);
    }
  } catch (error) {}
}

main();
