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
var onConnectionData = null;

server.listen(PORT, () => {
  console.log("Servidor escuchando en puerto " + PORT);
});

// Función para guardar los datos de streaming en la variable onConnectionData
function deepMerge(target, source) {
  for (const key in source) {
    if (source[key] instanceof Object && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

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

      // Guardar ultima información de retransmisión
      const parsedData = JSON.parse(data);
      if (parsedData.R) {
        onConnectionData = data;
        console.log("Saved on connection data.");
      }

      // Guardar ultima información de streaming y actualizar estado de la variable
      if (data.length > 5) {
        if (!onConnectionData) {
          return;
        }

        // Actualizar el estado de la variable on connection data
        if (Array.isArray(parsedData.M)) {
          console.log("Streaming data received");
          parsedData.M.forEach((update) => {
            if (update.H === "Streaming" && update.M === "feed") {
              const [feedName, data, timestamp] = update.A;

              if (!onConnectionData || !onConnectionData.R) {
                return;
              }

              switch (feedName) {
                case "Heartbeat":
                  if (onConnectionData?.R?.Heartbeat) {
                    deepMerge(onConnectionData.R.Heartbeat, data);
                  }
                  break;

                case "CarData.z":
                  if (onConnectionData?.R?.CarData) {
                    deepMerge(onConnectionData.R.CarData, data);
                  }
                  break;

                case "Position.z":
                  if (onConnectionData?.R?.Position) {
                    deepMerge(onConnectionData.R.Position, data);
                  }
                  break;

                case "TimingData":
                  if (onConnectionData?.R?.TimingData) {
                    deepMerge(onConnectionData.R.TimingData, data);
                  }
                  break;

                case "TimingStats":
                  if (onConnectionData?.R?.TimingStats) {
                    deepMerge(onConnectionData.R.TimingStats, data);
                  }
                  break;

                case "TimingAppData":
                  if (onConnectionData?.R?.TimingAppData) {
                    deepMerge(onConnectionData.R.TimingAppData, data);
                  }
                  break;

                case "WeatherData":
                  if (onConnectionData?.R?.WeatherData) {
                    deepMerge(onConnectionData.R.WeatherData, data);
                  }
                  break;

                case "TrackStatus":
                  if (onConnectionData?.R?.TrackStatus) {
                    deepMerge(onConnectionData.R.TrackStatus, data);
                  }
                  break;

                case "DriverList":
                  if (onConnectionData?.R?.DriverList) {
                    deepMerge(onConnectionData.R.DriverList, data);
                  }
                  break;

                case "RaceControlMessages":
                  if (onConnectionData?.R?.RaceControlMessages) {
                    deepMerge(onConnectionData.R.RaceControlMessages, data);
                  }
                  break;

                case "SessionInfo":
                  if (onConnectionData?.R?.SessionInfo) {
                    deepMerge(onConnectionData.R.SessionInfo, data);
                  }
                  break;

                case "SessionData":
                  if (onConnectionData?.R?.SessionData) {
                    deepMerge(onConnectionData.R.SessionData, data);
                  }
                  break;

                case "ExtrapolatedClock":
                  if (onConnectionData?.R?.ExtrapolatedClock) {
                    deepMerge(onConnectionData.R.ExtrapolatedClock, data);
                  }
                  break;

                case "TyreStintSeries":
                  if (onConnectionData?.R?.TyreStintSeries) {
                    deepMerge(onConnectionData.R.TyreStintSeries, data);
                  }
                  break;

                case "TopThree":
                  if (onConnectionData?.R?.TopThree) {
                    deepMerge(onConnectionData.R.TopThree, data);
                  }
                  break;

                default:
                  console.warn(
                    `Feed "${feedName}" no reconocido o propiedad no definida.`
                  );
              }
            }
          });
        }
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

  if (onConnectionData != null) {
    ws.send(onConnectionData);
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
