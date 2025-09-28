var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const express = require("express");
const axios = require("axios");
const ws = require("ws");
const cors = require("cors");
const http = require("http");
const ical = require("ical");
const signalR = require("@microsoft/signalr");
require("dotenv").config();
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
app.get("/calendar", (req, res) => __awaiter(this, void 0, void 0, function* () {
    try {
        const calendarUrl = "https://ics.ecal.com/ecal-sub/689fc469915d6b00080fec00/Formula%201.ics";
        const response = yield axios.get(calendarUrl);
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
            const hours = Math.floor((timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
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
    }
    catch (error) {
        console.error("Error al obtener el calendario:", error);
        res.status(500).json({
            success: false,
            error: "Error al obtener el calendario",
            message: error.message,
        });
    }
}));
app.get("/upcoming", (req, res) => __awaiter(this, void 0, void 0, function* () {
    try {
        const calendarUrl = "https://ics.ecal.com/ecal-sub/689fc469915d6b00080fec00/Formula%201.ics";
        const response = yield axios.get(calendarUrl);
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
            const hours = Math.floor((timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
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
            lastUpdated: new Date().toISOString(),
        });
    }
    catch (error) {
        console.error("Error al obtener el calendario:", error);
        res.status(500).json({
            success: false,
            error: "Error al obtener el calendario",
            message: error.message,
        });
    }
}));
app.get("/download-mp3", (req, res) => __awaiter(this, void 0, void 0, function* () {
    try {
        const urlMP3 = req.query.url;
        const idx = req.query.idx;
        if (!urlMP3) {
            return res.status(400).send("URL required");
        }
        if (!isSafe(urlMP3)) {
            return res.status(400).send("URL not allowed");
        }
        const response = yield axios({
            method: "get",
            url: urlMP3,
            responseType: "stream",
        });
        const filename = "f1telemetry-audio" + idx + ".mp3";
        res.setHeader("Content-Disposition", 'attachment; filename=' + filename);
        res.setHeader("Content-Type", response.headers["content-type"]);
        response.data.pipe(res);
    }
    catch (error) {
        console.error("Error:", error.message);
        res.status(500).send("Error at file download");
    }
}));
let frontendSockets = [];
var fullState = { R: {} };
let reconnectInterval = 1000;
const maxReconnectInterval = 30000;
const reconnectBackoff = 1.5;
let reconnectAttempts = 0;
const maxReconnectAttempts = 3;
server.listen(PORT, () => {
    console.log("Server listening in port: " + PORT);
});
function isSafe(url) {
    return url.startsWith('https://livetiming.formula1.com/');
}
// Función para guardar los datos de streaming en la variable fullState
function deepMerge(target, source) {
    for (const key in source) {
        if (Array.isArray(source[key])) {
            console.log("Array replaced at key:", key);
            target[key] = source[key];
        }
        else if (source[key] instanceof Object && source[key] !== null) {
            if (!target[key] || typeof target[key] !== "object") {
                target[key] = {};
            }
            deepMerge(target[key], source[key]);
        }
        else {
            target[key] = source[key];
        }
    }
}
// Negociación sin F1TV Premium
function negotiate() {
    return __awaiter(this, void 0, void 0, function* () {
        const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
        const url = `https://livetiming.formula1.com/signalr/negotiate?connectionData=${hub}&clientProtocol=1.5`;
        const resp = yield axios.get(url);
        return resp;
    });
}
// Conexión vieja sin F1TV Premium
function connectwss(token, cookie) {
    return __awaiter(this, void 0, void 0, function* () {
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
                // Guardar ultima información de retransmisión
                const parsedData = JSON.parse(data);
                if (parsedData.R) {
                    fullState = parsedData;
                    console.log("Basic data subscription fullfilled");
                }
                // Actualizar el estado de la variable on connection data
                if (Array.isArray(parsedData.M)) {
                    console.log("Basic streaming data received");
                    parsedData.M.forEach((update) => {
                        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
                        if (update.H === "Streaming" && update.M === "feed") {
                            const [feedName, data, timestamp] = update.A;
                            if (!fullState || !fullState.R) {
                                return;
                            }
                            switch (feedName) {
                                case "Heartbeat":
                                    if ((_a = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _a === void 0 ? void 0 : _a.Heartbeat) {
                                        deepMerge(fullState.R.Heartbeat, data);
                                    }
                                    break;
                                case "CarData.z":
                                    if ((_b = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _b === void 0 ? void 0 : _b.CarData) {
                                        deepMerge(fullState.R.CarData, data);
                                    }
                                    break;
                                case "Position.z":
                                    if ((_c = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _c === void 0 ? void 0 : _c.Position) {
                                        deepMerge(fullState.R.Position, data);
                                    }
                                    break;
                                case "TimingData":
                                    if ((_d = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _d === void 0 ? void 0 : _d.TimingData) {
                                        deepMerge(fullState.R.TimingData, data);
                                    }
                                    break;
                                case "TimingStats":
                                    if ((_e = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _e === void 0 ? void 0 : _e.TimingStats) {
                                        deepMerge(fullState.R.TimingStats, data);
                                    }
                                    break;
                                case "TimingAppData":
                                    if ((_f = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _f === void 0 ? void 0 : _f.TimingAppData) {
                                        deepMerge(fullState.R.TimingAppData, data);
                                    }
                                    break;
                                case "WeatherData":
                                    if ((_g = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _g === void 0 ? void 0 : _g.WeatherData) {
                                        deepMerge(fullState.R.WeatherData, data);
                                    }
                                    break;
                                case "TrackStatus":
                                    if ((_h = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _h === void 0 ? void 0 : _h.TrackStatus) {
                                        deepMerge(fullState.R.TrackStatus, data);
                                    }
                                    break;
                                case "DriverList":
                                    if ((_j = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _j === void 0 ? void 0 : _j.DriverList) {
                                        deepMerge(fullState.R.DriverList, data);
                                    }
                                    break;
                                case "RaceControlMessages":
                                    if ((_k = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _k === void 0 ? void 0 : _k.RaceControlMessages) {
                                        deepMerge(fullState.R.RaceControlMessages, data);
                                    }
                                    break;
                                case "SessionInfo":
                                    if ((_l = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _l === void 0 ? void 0 : _l.SessionInfo) {
                                        deepMerge(fullState.R.SessionInfo, data);
                                    }
                                    break;
                                case "SessionData":
                                    if ((_m = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _m === void 0 ? void 0 : _m.SessionData) {
                                        deepMerge(fullState.R.SessionData, data);
                                    }
                                    break;
                                case "ExtrapolatedClock":
                                    if ((_o = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _o === void 0 ? void 0 : _o.ExtrapolatedClock) {
                                        deepMerge(fullState.R.ExtrapolatedClock, data);
                                    }
                                    break;
                                case "TyreStintSeries":
                                    if ((_p = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _p === void 0 ? void 0 : _p.TyreStintSeries) {
                                        deepMerge(fullState.R.TyreStintSeries, data);
                                    }
                                    break;
                                case "TopThree":
                                    if ((_q = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _q === void 0 ? void 0 : _q.TopThree) {
                                        deepMerge(fullState.R.TopThree, data);
                                    }
                                    break;
                                default:
                                    console.warn(`Feed "${feedName}" no reconocido o propiedad no definida.`);
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
    });
}
// Negociación con F1TV Premium
function negotiatePremium(subscriptionToken) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        try {
            const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
            const url = `https://livetiming.formula1.com/signalrcore/negotiate?connectionData=${hub}&clientProtocol=1.5`;
            const headers = {
                Authorization: `Bearer ${subscriptionToken}`,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                Accept: "application/json, text/plain, */*",
                "Accept-Encoding": "gzip, deflate, br",
                Origin: "https://account.formula1.com",
                Referer: "https://account.formula1.com/",
                "Content-Type": "application/json",
            };
            const response = yield axios.post(url, null, { headers });
            return response;
        }
        catch (error) {
            console.log("Error during negotiation:", ((_a = error.response) === null || _a === void 0 ? void 0 : _a.data) || error.message);
        }
    });
}
// Conexión nueva con F1TV Premium
function connectWithSignalRPremium(subscriptionToken, cookies) {
    return __awaiter(this, void 0, void 0, function* () {
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
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
            if (!fullState.R) {
                return;
            }
            switch (feedName) {
                case "Heartbeat":
                    if ((_a = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _a === void 0 ? void 0 : _a.Heartbeat) {
                        deepMerge(fullState.R.Heartbeat, data);
                    }
                    break;
                case "CarData.z":
                    if ((_b = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _b === void 0 ? void 0 : _b.CarData) {
                        deepMerge(fullState.R.CarData, data);
                    }
                    break;
                case "Position.z":
                    if ((_c = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _c === void 0 ? void 0 : _c.Position) {
                        deepMerge(fullState.R.Position, data);
                    }
                    break;
                case "TimingData":
                    if ((_d = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _d === void 0 ? void 0 : _d.TimingData) {
                        deepMerge(fullState.R.TimingData, data);
                    }
                    break;
                case "TimingStats":
                    if ((_e = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _e === void 0 ? void 0 : _e.TimingStats) {
                        deepMerge(fullState.R.TimingStats, data);
                    }
                    break;
                case "TimingAppData":
                    if ((_f = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _f === void 0 ? void 0 : _f.TimingAppData) {
                        deepMerge(fullState.R.TimingAppData, data);
                    }
                    break;
                case "WeatherData":
                    if ((_g = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _g === void 0 ? void 0 : _g.WeatherData) {
                        deepMerge(fullState.R.WeatherData, data);
                    }
                    break;
                case "TrackStatus":
                    if ((_h = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _h === void 0 ? void 0 : _h.TrackStatus) {
                        deepMerge(fullState.R.TrackStatus, data);
                    }
                    break;
                case "DriverList":
                    if ((_j = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _j === void 0 ? void 0 : _j.DriverList) {
                        deepMerge(fullState.R.DriverList, data);
                    }
                    break;
                case "RaceControlMessages":
                    if ((_k = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _k === void 0 ? void 0 : _k.RaceControlMessages) {
                        deepMerge(fullState.R.RaceControlMessages, data);
                    }
                    break;
                case "SessionInfo":
                    if ((_l = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _l === void 0 ? void 0 : _l.SessionInfo) {
                        if (data.SessionStatus === "Inactive") {
                            console.log("Inactive session detected, cleaning some attributes...");
                            fullState.R.TimingAppData = null;
                            fullState.R.TyreStintSeries = null;
                            Object.keys(fullState.R.TimingData.Lines).forEach((key) => {
                                if (fullState.R.TimingData.Lines[key] &&
                                    typeof fullState.R.TimingData.Lines[key] === "object") {
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
                                if (fullState.R.TimingStats.Lines[key] &&
                                    typeof fullState.R.TimingStats.Lines[key] === "object") {
                                    fullState.R.TimingStats.Lines[key].PersonalBestLapTime.Value =
                                        "";
                                    fullState.R.TimingStats.Lines[key].PersonalBestLapTime.Lap = "";
                                    fullState.R.TimingStats.Lines[key].PersonalBestLapTime.Position = "";
                                }
                            });
                        }
                        deepMerge(fullState.R.SessionInfo, data);
                    }
                    break;
                case "SessionData":
                    if ((_m = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _m === void 0 ? void 0 : _m.SessionData) {
                        deepMerge(fullState.R.SessionData, data);
                    }
                    break;
                case "ExtrapolatedClock":
                    if ((_o = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _o === void 0 ? void 0 : _o.ExtrapolatedClock) {
                        deepMerge(fullState.R.ExtrapolatedClock, data);
                    }
                    break;
                case "TyreStintSeries":
                    if ((_p = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _p === void 0 ? void 0 : _p.TyreStintSeries) {
                        deepMerge(fullState.R.TyreStintSeries, data);
                    }
                    break;
                case "TeamRadio":
                    if ((_q = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _q === void 0 ? void 0 : _q.TeamRadio) {
                        deepMerge(fullState.R.TeamRadio, data);
                    }
                    break;
                case "TopThree":
                    if ((_r = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _r === void 0 ? void 0 : _r.TopThree) {
                        deepMerge(fullState.R.TopThree, data);
                    }
                    break;
                case "LapCount":
                    if ((_s = fullState === null || fullState === void 0 ? void 0 : fullState.R) === null || _s === void 0 ? void 0 : _s.LapCount) {
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
            yield connection.start();
            const subscriptionData = yield connection.invoke("Subscribe", [
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
        }
        catch (error) {
            console.error("Connection failed: ", error);
            throw error;
        }
    });
}
// Estableciendo nuestro WebSocket
const wss = new ws.WebSocketServer({ server });
wss.on("connection", (ws) => {
    frontendSockets.push(ws);
    console.log("New client connected. Total clients: %d", frontendSockets.length);
    if (fullState != null) {
        const buffer = Buffer.from(JSON.stringify(fullState));
        ws.send(buffer);
    }
    ws.on("close", () => {
        frontendSockets = frontendSockets.filter((c) => c !== ws);
    });
});
// Función principal
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const subscriptionToken = process.env.F1TVSUBSCRIPTION_TOKEN;
            let negotiation, sock;
            try {
                negotiation = yield negotiatePremium(subscriptionToken);
                if (negotiation && negotiation.status === 200) {
                    sock = yield connectWithSignalRPremium(subscriptionToken, negotiation.headers["set-cookie"]);
                    return;
                }
            }
            catch (premiumError) {
                console.warn("Failed premium connection.");
            }
            // Si la negociación premium falla, negociar y conectar sin cuenta premium
            try {
                console.log("Started common negotiation");
                negotiation = yield negotiate();
                sock = yield connectwss(resp.data["ConnectionToken"], resp.headers["set-cookie"]);
                sock.send(JSON.stringify({
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
                }));
            }
            catch (error) {
                console.log("Common connection closed, attempting to reconnect in " +
                    reconnectInterval / 1000 +
                    "s.");
                reconnectAttempts++;
                if (reconnectAttempts < maxReconnectAttempts) {
                    reconnectInterval = Math.min(reconnectInterval * reconnectBackoff, maxReconnectInterval);
                    setTimeout(() => {
                        connectWithSignalRPremium(subscriptionToken, cookies);
                    }, reconnectInterval);
                }
                else {
                    console.error(`Reached ${maxReconnectAttempts} attempts, failed to reconnect. `);
                }
            }
        }
        catch (e) {
            console.error(e);
        }
    });
}
main();
//# sourceMappingURL=server.js.map