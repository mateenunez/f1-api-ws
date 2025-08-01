const express = require("express");
const axios = require("axios");
const ws = require("ws");
const cors = require("cors");
const http = require("http");

const app = express();
const server = http.createServer(app);
const PORT = 4000;

app.use(cors());

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <title>F1 WebSocket Proxy</title>
        <style>
          body { font-family: Arial, sans-serif; background: #111; color: #fff; text-align: start; margin-top: 10%; margin-left: 10%;}
          .status { font-size: 1em; margin-top: 20px; color: #57de44; }
          .description { font-size: 0.8em; margin-top: 30px; display: flex; gap: 10px; flex-direction:column;}
          .link {text-decoration: none; color: #5c67ffff;}
        </style>
      </head>
      <body>
        <h1>F1 Websocket Proxy</h1>
        <div class="status">WebSocket active</div>
        <div class="description">
        <div> This is a websocket connection for <a href="https://f1telemetry.vercel.app/" class="link" >F1 Telemetry<a/>, captures F1 signal and sends the data with no modifications to the client. </div>
        <div> This websocket doesn't need authorization, if you found this websocket and want to get the information please consider to notify the owner in order to preserve de free hosting of render. </div>
        <a href="https://cafecito.app/skoncito" class="link">@skoncito </a>
        </div>
        </body>
    </html>
  `);
});

let frontendSockets = [];

let latestRetransmitionData = null;

server.listen(PORT, () => {
  console.log("Servidor escuchando en puerto " + PORT);
});

// Negociación
async function negotiate() {
  const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
  const url = `https://livetiming.formula1.com/signalr/negotiate?connectionData=${hub}&clientProtocol=1.5`;
  const resp = await axios.get(url);
  return resp;
}

// Conexión
async function connectwss(token, cookie) {
  const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
  const encodedToken = encodeURIComponent(token);
  const url = `wss://livetiming.formula1.com/signalr/connect?clientProtocol=1.5&transport=webSockets&connectionToken=${encodedToken}&connectionData=${hub}`;
  const p = new Promise((res, rej) => {
    const sock = new ws.WebSocket(url, {
      headers: {
        "User-Agent": "BestHTTP",
        "Accept-Encoding": "gzip,identity",
        Cookie: cookie,
      },
    });

    sock.on("open", (ev) => {
      res(sock);

    });
    
    sock.on("message", (data) => {
      console.log("Clients connected: %d", frontendSockets.length);

      const parsedData = JSON.parse(data);

      // Guardar ultima informacion de retransmision
      if (parsedData.R){
        latestRetransmitionData = data;
        console.log("Retransmission data received.");
      }

      frontendSockets.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });
    });
  });
  return p;
}

// Estableciendo nuestro WebSocket
const wss = new ws.WebSocketServer({ server });
wss.on("connection", (ws) => {
  frontendSockets.push(ws);

  if (latestRetransmitionData != null) {
    ws.send(latestRetransmitionData);
  }

  ws.on("close", () => {
    frontendSockets = frontendSockets.filter((c) => c !== ws);
  });
});

async function main() {
  try {
    const resp = await negotiate();

    const sock = await connectwss(
      resp.data["ConnectionToken"],
      resp.headers["set-cookie"]
    );

    sock.send(
      JSON.stringify({
        H: "Streaming",
        M: "Subscribe",
        A: [
          [
            "Heartbeat",
            "CarData.z",
            "Position.z",
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
            "ChampionshipPrediction",
            "TyreStintSeries",
            "PitStopSeries",
          ],
        ],
        I: 1,
      })
    );
  } catch (e) {
    console.error(e);
  }
}

main();
