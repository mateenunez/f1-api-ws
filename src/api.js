// api.js
const express = require("express");
const router = express.Router();
const ical = require("ical");
const axios = require("axios");

function isSafe(url) {
  return url.startsWith("https://livetiming.formula1.com/");
}

router.get("/", (req, res) => {
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

router.get("/calendar", async (req, res) => {
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
    console.error("Error al obtener el calendario:", error);
    res.status(500).json({
      success: false,
      error: "Error al obtener el calendario",
      message: error.message,
    });
  }
});

router.get("/upcoming", async (req, res) => {
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
  } catch (error) {
    console.error("Error al obtener el calendario:", error);
    res.status(500).json({
      success: false,
      error: "Error al obtener el calendario",
      message: error.message,
    });
  }
});

router.get("/download-mp3", async (req, res) => {
  try {
    const urlMP3 = req.query.url;
    const idx = req.query.idx;

    if (!urlMP3) {
      return res.status(400).send("URL required");
    }

    if (!isSafe(urlMP3)) {
      return res.status(400).send("URL not allowed");
    }

    const response = await axios({
      method: "get",
      url: urlMP3,
      responseType: "stream",
    });

    const filename = "f1telemetry-audio" + idx + ".mp3";
    res.setHeader("Content-Disposition", "attachment; filename=" + filename);
    res.setHeader("Content-Type", response.headers["content-type"]);

    response.data.pipe(res);
  } catch (error) {
    console.error("Error:", error.message);
    res.status(500).send("Error at file download");
  }
});

module.exports = {
  router
};
