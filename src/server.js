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
          body { font-family: Arial, sans-serif; background: #111; color: #fff; text-align: center; margin-top: 10%; }
          .status { font-size: 2em; margin-top: 20px; }
        </style>
      </head>
      <body>
        <h1>F1 WebSocket Proxy</h1>
        <div class="status">WebSocket activo ✅</div>
       </body>
    </html>
  `);;
});

let frontendSockets = [];
let latestData = null;

server.listen(PORT, () => {
  console.log("Servidor escuchando en puerto " + PORT);
});



// Conexion con F1
async function negotiate() {
  const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
  const url = `https://livetiming.formula1.com/signalr/negotiate?connectionData=${hub}&clientProtocol=1.5`;
  const resp = await axios.get(url);
  return resp;
}

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
  
      
      if (data.length > 5){
        latestData = data;
        console.log("Information exchange.")
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

  if (latestData != null) {
    ws.send(latestData);
  }

  ws.on("close", () => {
    frontendSockets = frontendSockets.filter((c) => c !== ws);
  });
});

async function main() {
  try {
    const resp = await negotiate();

    // console.log(resp.data);
    // console.log(resp.headers);

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
