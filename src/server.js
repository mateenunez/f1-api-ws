const express = require("express");
const axios = require("axios");
const ws = require("ws");
const cors = require("cors");
const http = require("http");
const ical = require("ical");

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
          .legal h3 {text-decoration: none; color: #5c67ffff;}
        </style>
      </head>
      <body>
        <h1>F1 Websocket Proxy</h1>
        <div class="status">WebSocket active</div>
        <div class="description">
        <div> This is a websocket connection for the F1 Telemetry, captures F1 signal and sends the data with no modifications to the client. </div>
        <div> This websocket doesn't need authorization, if you found this websocket and want to get the information please consider to notify the owner in order to preserve the free hosting. </div>
        <div class="legal">
          <h3>LEGAL DISCLAIMER & TERMS OF USE</h3>
          <p><strong>PERSONAL USE ONLY:</strong> This backend service is developed and maintained for personal, non-commercial use only. It is not intended for commercial, business, or lucrative purposes.</p>
          
          <p><strong>NO COMMERCIAL INTENT:</strong> The owner of this service has no intentions to generate revenue, profit, or commercial gain from this backend. This is a personal project for educational and personal entertainment purposes.</p>
          
          <p><strong>NO WARRANTIES:</strong> This service is provided "AS IS" without any warranties, express or implied. The owner makes no representations about the reliability, accuracy, or completeness of the information provided.</p>
          
          <p><strong>LIMITATION OF LIABILITY:</strong> The owner of this backend service shall not be held responsible, liable, or accountable for any damages, losses, or consequences arising from the use, misuse, or inability to use this service. Users access and use this service at their own risk.</p>
          
          <p><strong>USER RESPONSIBILITY:</strong> Users are solely responsible for their use of this service and must comply with all applicable laws and regulations. The owner assumes no responsibility for user actions or the consequences thereof.</p>
          
          <p><strong>NO ENDORSEMENT:</strong> This service is not affiliated with, endorsed by, or sponsored by Formula 1, FIA, or any official racing organizations. All data and information are obtained from publicly available sources.</p>
          
          <p><strong>ACCEPTANCE:</strong> By accessing or using this service, you acknowledge that you have read, understood, and agree to these terms. If you do not agree, please do not use this service.</p>
        </div>
        </div>
        </body>
    </html>
  `);
});

app.get("/calendar", async (req, res) => {
  try {
    const calendarUrl =
      "https://ics.ecal.com/ecal-sub/689fc469915d6b00080fec00/Formula%201.ics";

    const response = await axios.get(calendarUrl);
    const calendarData = response.data;

    const events = ical.parseICS(calendarData);

    const formattedEvents = [];
    const now = new Date();

    for (let eventId in events) {
      const event = events[eventId];

      if (event.start && event.start > now) {
        formattedEvents.push({
          id: eventId,
          summary: event.summary || "Evento F1",
          start: event.start,
          end: event.end,
          location: event.location || "",
          status: event.status || "CONFIRMED",
        });
      }
    }

    formattedEvents.sort((a, b) => a.start - b.start);

    const nextEvent = formattedEvents.length > 0 ? formattedEvents[0] : null;

    let timeUntilNext = null;
    if (nextEvent) {
      const timeDiff = nextEvent.start - now;
      const days = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
      const hours = Math.floor(
        (timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
      );
      const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));

      timeUntilNext = {
        days,
        hours,
        minutes,
        totalMinutes: Math.floor(timeDiff / (1000 * 60)),
        totalHours: Math.floor(timeDiff / (1000 * 60 * 60)),
      };
    }

    res.json({
      success: true,
      nextEvent,
      timeUntilNext,
      totalEvents: formattedEvents.length,
      upcomingEvents: formattedEvents.slice(0, 5), // Próximos 5 eventos
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error al obtener el calendario:", error);
    res.status(500).json({
      success: false,
      error: "Error al obtener el calendario",
      message: error.message,
    });
  }
});

let frontendSockets = [];
var fullState = null;

server.listen(PORT, () => {
  console.log("Servidor escuchando en puerto " + PORT);
});

// Función para guardar los datos de streaming en la variable fullState
function deepMerge(target, source) {
  for (const key in source) {
    if (Array.isArray(source[key])) {
      target[key] = source[key];
    } else if (source[key] instanceof Object && source[key] !== null) {
      if (!target[key] || typeof target[key] !== "object") {
        target[key] = {};
      }
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
      console.log(data);
      // Guardar ultima información de retransmisión
      const parsedData = JSON.parse(data);
      if (parsedData.R) {
        fullState = parsedData;
        console.log("Saved on connection data.");
      }

      // Actualizar el estado de la variable on connection data
      if (Array.isArray(parsedData.M)) {
        console.log("Streaming data received");
        parsedData.M.forEach((update) => {
          if (update.H === "Streaming" && update.M === "feed") {
            const [feedName, data, timestamp] = update.A;

            if (!fullState || !fullState.R) {
              return;
            }

            switch (feedName) {
              case "Heartbeat":
                if (fullState?.R?.Heartbeat) {
                  deepMerge(fullState.R.Heartbeat, data);
                }
                break;

              case "CarData.z":
                if (fullState?.R?.CarData) {
                  deepMerge(fullState.R.CarData, data);
                }
                break;

              case "Position.z":
                if (fullState?.R?.Position) {
                  deepMerge(fullState.R.Position, data);
                }
                break;

              case "TimingData":
                if (fullState?.R?.TimingData) {
                  deepMerge(fullState.R.TimingData, data);
                }
                break;

              case "TimingStats":
                if (fullState?.R?.TimingStats) {
                  deepMerge(fullState.R.TimingStats, data);
                }
                break;

              case "TimingAppData":
                if (fullState?.R?.TimingAppData) {
                  deepMerge(fullState.R.TimingAppData, data);
                }
                break;

              case "WeatherData":
                if (fullState?.R?.WeatherData) {
                  deepMerge(fullState.R.WeatherData, data);
                }
                break;

              case "TrackStatus":
                if (fullState?.R?.TrackStatus) {
                  deepMerge(fullState.R.TrackStatus, data);
                }
                break;

              case "DriverList":
                if (fullState?.R?.DriverList) {
                  deepMerge(fullState.R.DriverList, data);
                }
                break;

              case "RaceControlMessages":
                if (fullState?.R?.RaceControlMessages) {
                  deepMerge(fullState.R.RaceControlMessages, data);
                }
                break;

              case "SessionInfo":
                if (fullState?.R?.SessionInfo) {
                  deepMerge(fullState.R.SessionInfo, data);
                }
                break;

              case "SessionData":
                if (fullState?.R?.SessionData) {
                  deepMerge(fullState.R.SessionData, data);
                }
                break;

              case "ExtrapolatedClock":
                if (fullState?.R?.ExtrapolatedClock) {
                  deepMerge(fullState.R.ExtrapolatedClock, data);
                }
                break;

              case "TyreStintSeries":
                if (fullState?.R?.TyreStintSeries) {
                  deepMerge(fullState.R.TyreStintSeries, data);
                }
                break;

              case "TopThree":
                if (fullState?.R?.TopThree) {
                  deepMerge(fullState.R.TopThree, data);
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

  if (fullState != null) {
    const buffer = Buffer.from(JSON.stringify(fullState));
    ws.send(buffer);
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
  } catch (e) {
    console.error(e);
  }
}

main();
