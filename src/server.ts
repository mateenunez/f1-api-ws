import express from "express";
import axios, { AxiosError, AxiosResponse } from "axios";
import ws from "ws";
import cors from "cors";
import http from "http";
import ical from "ical";
import signalR, { HubConnection } from "@microsoft/signalr";
import dotenv from 'dotenv';
import { exit } from "process";

dotenv.config();

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

interface FormattedEvent {
  id: string;
  summary: string;
  start: Date;
  end?: Date,
  location: string;
  status: string;
}

const calendarHandler = async (req: express.Request, res: express.Response) => {
  try {
    const calendarUrl =
      "https://ics.ecal.com/ecal-sub/689fc469915d6b00080fec00/Formula%201.ics";

    const response = await axios.get(calendarUrl);
    const calendarData = response.data;

    const events = ical.parseICS(calendarData);

    const formattedEvents: FormattedEvent[] = [];
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
          status: event.status ? event.status.toString() : "CONFIRMED",
        });
      }
    }

    formattedEvents.sort((a: FormattedEvent, b: FormattedEvent) => a.start.getMilliseconds() - b.start.getMilliseconds());

    const nextEvent = formattedEvents.length > 0 ? formattedEvents[0] : null;

    let timeUntilNext = null;
    if (nextEvent) {
      const timeDiff = nextEvent.start.getMilliseconds() - now.getMilliseconds();
      const days = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
      const hours = Math.floor(
        (timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
      );
      const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((timeDiff % (1000 * 60)) / 1000);

      timeUntilNext = {
        days,
        hours,
        minutes,
        seconds,
        totalMinutes: Math.floor(timeDiff / (1000 * 60)),
        totalHours: Math.floor(timeDiff / (1000 * 60 * 60)),
      };
    }

    res.json({
      success: true,
      nextEvent,
      timeUntilNext,
      totalEvents: formattedEvents.length,
      upcomingEvents: formattedEvents,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error."
    console.error("Error al obtener el calendario:", error);
    res.status(500).json({
      success: false,
      error: "Error al obtener el calendario",
      message,
    });
  }
};

app.get("/calendar", calendarHandler);

app.get("/upcoming", calendarHandler);

app.get("/download-mp3", async (req, res) => {
  try {
    const urlMP3 = req.query.url;
    const idx = req.query.idx;

    if (!urlMP3) {
      return res.status(400).send("URL required");
    }

    if (!isSafe(urlMP3.toString())) {
      return res.status(400).send("URL not allowed");
    }
    const response = await axios({
      method: "get",
      url: urlMP3.toString(),
      responseType: "stream",
    });

    const filename = "f1telemetry-audio" + idx + ".mp3";
    res.setHeader("Content-Disposition", 'attachment; filename=' + filename);
    res.setHeader("Content-Type", response.headers["content-type"]);

    response.data.pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error."
    console.error("Error:", message);
    res.status(500).send("Error at file download");
  }
});


let frontendSockets: ws.WebSocket[] = [];
var fullState: { R: any } = { R: {} };
let reconnectInterval = 1000;
const maxReconnectInterval = 30000;
const reconnectBackoff = 1.5;
let reconnectAttempts = 0;
const maxReconnectAttempts = 3;

server.listen(PORT, () => {
  console.log("Server listening in port: " + PORT);
});

function isSafe(url: string) {
  return url.startsWith('https://livetiming.formula1.com/');
}

// Función para guardar los datos de streaming en la variable fullState
function deepMerge(target: any, source: any) {
  for (const key in source) {
    if (Array.isArray(source[key])) {
      console.log("Array replaced at key:", key);
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

// Negociación sin F1TV Premium
async function negotiate(): Promise<AxiosResponse> {
  const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
  const url = `https://livetiming.formula1.com/signalr/negotiate?connectionData=${hub}&clientProtocol=1.5`;
  const resp = await axios.get(url);
  return resp;
}

// Conexión vieja sin F1TV Premium
async function connectwss(token: string, cookie: string): Promise<ws.WebSocket> {
  const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
  const encodedToken = encodeURIComponent(token);
  const url = `wss://livetiming.formula1.com/signalr/connect?clientProtocol=1.5&transport=webSockets&connectionToken=${encodedToken}&connectionData=${hub}`;

  return new Promise((resolve: (value: ws.WebSocket) => void, reject: (reason?: any) => void) => {
    const sock = new ws.WebSocket(url, {
      headers: {
        "User-Agent": "BestHTTP",
        "Accept-Encoding": "gzip,identity",
        Cookie: cookie,
      },
    });

    sock.on("open", () => {
      resolve(sock);
    });

    sock.on("message", (data: ws.RawData) => {
      // Guardar ultima información de retransmisión
      const parsedData = JSON.parse(data.toString());
      if (parsedData.R) {
        fullState = parsedData;
        console.log("Basic data subscription fullfilled");
      }

      // Actualizar el estado de la variable on connection data
      if (Array.isArray(parsedData.M)) {
        console.log("Basic streaming data received");
        parsedData.M.forEach((update: any) => {
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
}

// Negociación con F1TV Premium
async function negotiatePremium(subscriptionToken: string): Promise<AxiosResponse> {
  try {
    const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
    const url = `https://livetiming.formula1.com/signalrcore/negotiate?connectionData=${hub}&clientProtocol=1.5`;
    const headers = {
      Authorization: `Bearer ${subscriptionToken}`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Accept-Encoding": "gzip, deflate, br",
      Origin: "https://account.formula1.com",
      Referer: "https://account.formula1.com/",
      "Content-Type": "application/json",
    };
    const response = await axios.post(url, null, { headers });
    return response;
  } catch (error) {
    const e: AxiosError = error as AxiosError;
    console.log(
      "Error during negotiation:",
      e.response?.data || e.message
    );
    return Promise.reject(error);
  }
}

// Conexión nueva con F1TV Premium
async function connectWithSignalRPremium(subscriptionToken: string, cookies: string[]): Promise<signalR.HubConnection> {
  const cookieString = cookies
    .map((cookie) => cookie.split(";")[0].trim())
    .join("; ");
  const connection = new signalR.HubConnectionBuilder()
    .withUrl("https://livetiming.formula1.com/signalrcore", {
      transport: signalR.HttpTransportType.WebSockets,
      accessTokenFactory: () => subscriptionToken,
      headers: {
        Cookie: cookieString,
        "User-Agent": "BestHTTP",
        "Accept-Encoding": "gzip,identity",
      },
    })
    .configureLogging(signalR.LogLevel.Information)
    .build();

  connection.on("feed", (feedName, data, timestamp) => {
    if (!fullState.R) {
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
          if (data.SessionStatus === "Inactive") {
            console.log(
              "Inactive session detected, cleaning some attributes..."
            );
            fullState.R.TimingAppData = null;
            fullState.R.TyreStintSeries = null;
            Object.keys(fullState.R.TimingData.Lines).forEach((key) => {
              if (
                fullState.R.TimingData.Lines[key] &&
                typeof fullState.R.TimingData.Lines[key] === "object"
              ) {
                fullState.R.TimingData.Lines[key].NumberOfPitStops = 0;
                fullState.R.TimingData.Lines[key].GapToLeader = "";
                fullState.R.TimingData.Lines[key].IntervalToPositionAhead = "";
                fullState.R.TimingData.Lines[key].TimeDiffToPositionAhead = "";
                fullState.R.TimingData.Lines[key].TimeDiffToFastest = "";
                fullState.R.TimingData.Lines[key].Stats = [];
                fullState.R.TimingData.Lines[key].Retired = false;
                fullState.R.TimingData.Lines[key].KnockedOut = false;
              }
            });
            Object.keys(fullState.R.TimingStats.Lines).forEach((key) => {
              if (
                fullState.R.TimingStats.Lines[key] &&
                typeof fullState.R.TimingStats.Lines[key] === "object"
              ) {
                fullState.R.TimingStats.Lines[key].PersonalBestLapTime.Value =
                  "";
                fullState.R.TimingStats.Lines[key].PersonalBestLapTime.Lap = "";
                fullState.R.TimingStats.Lines[
                  key
                ].PersonalBestLapTime.Position = "";
              }
            });
          }
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

      case "TeamRadio":
        if (fullState?.R?.TeamRadio) {
          deepMerge(fullState.R.TeamRadio, data);
        }
        break;

      case "TopThree":
        if (fullState?.R?.TopThree) {
          deepMerge(fullState.R.TopThree, data);
        }
        break;

      case "LapCount":
        if (fullState?.R?.LapCount) {
          deepMerge(fullState.R.LapCount, data);
        }
        break;

      default:
        console.warn(`Feed "${feedName}" not recognized.`);
    }

    frontendSockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        const streamingData = {
          M: [{ H: "Streaming", M: "feed", A: [feedName, data, timestamp] }],
        };
        ws.send(Buffer.from(JSON.stringify(streamingData)));
      }
    });
  });

  connection.onclose((error) => {
    console.log("Error at premium websocket: ", error);
    return error;
  });

  try {
    await connection.start();

    const subscriptionData = await connection.invoke("Subscribe", [
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
    ]);

    if (subscriptionData) {
      console.log("Premium data subscription fullfilled.");
      fullState.R = subscriptionData;
    }

    return connection;
  } catch (error) {
    console.error("Connection failed: ", error);
    throw error;
  }
}

// Estableciendo nuestro WebSocket
const wss = new ws.WebSocketServer({ server });
wss.on("connection", (ws: ws.WebSocket) => {
  frontendSockets.push(ws);
  console.log(
    "New client connected. Total clients: %d",
    frontendSockets.length
  );

  if (fullState != null) {
    const buffer = Buffer.from(JSON.stringify(fullState));
    ws.send(buffer);
  }

  ws.on("close", () => {
    frontendSockets = frontendSockets.filter((c) => c !== ws);
  });
});

// Función principal
async function main() {
  try {
    const subscriptionToken = process.env.F1TVSUBSCRIPTION_TOKEN;
    if (!subscriptionToken) {
      console.error("Subscription token not found");
      exit(1)
    }
    let negotiation: AxiosResponse;
    let cookies: string[];

    try {
      negotiation = await negotiatePremium(subscriptionToken);

      let sock: HubConnection;

      cookies = negotiation.headers["set-cookie"] ?? [];

      if (negotiation && negotiation.status === 200) {
        sock = await connectWithSignalRPremium(
          subscriptionToken,
          cookies
        );
        return;
      }
    } catch (premiumError) {
      console.warn("Failed premium connection.");
    }

    // Si la negociación premium falla, negociar y conectar sin cuenta premium
    try {
      console.log("Started common negotiation");
      const negotiationResponse = await negotiate();

      const cookies: string[] = negotiationResponse.headers["set-cookie"] ?? [];

      const cookieString = cookies
        .map((cookie) => cookie.split(";")[0].trim())
        .join("; ");

      const sock = await connectwss(
        negotiationResponse.data["ConnectionToken"],
        cookieString,
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
    } catch (error) {
      console.log(
        "Common connection closed, attempting to reconnect in " +
        reconnectInterval / 1000 +
        "s."
      );
      reconnectAttempts++;
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectInterval = Math.min(
          reconnectInterval * reconnectBackoff,
          maxReconnectInterval
        );
        setTimeout(() => {
          connectWithSignalRPremium(subscriptionToken, cookies);
        }, reconnectInterval);
      } else {
        console.error(
          `Reached ${maxReconnectAttempts} attempts, failed to reconnect. `
        );
      }
    }
  } catch (e) {
    console.error(e);
  }
}

main();
