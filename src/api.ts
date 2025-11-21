// api.js
import express from "express";
import dotenv from "dotenv";
const router = express.Router();
import ical from "ical";
import axios from "axios";
import { Response, Request } from "express";
dotenv.config();

interface IcalEvent {
  id: string;
  type: string;
  track: string;
  start: Date;
  end?: Date;
  location: string;
}

interface EventsByLocation {
  track: string;
  location: string;
  p1?: IcalEvent;
  p2?: IcalEvent;
  p3?: IcalEvent;
  q?: IcalEvent;
  r?: IcalEvent;
  sq?: IcalEvent;
  sr?: IcalEvent;
  start: Date;
}

function isSafe(url: string) {
  return url.startsWith("https://livetiming.formula1.com/");
}

function parseIcalDate(raw: any): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;

  let s = String(raw).trim();
  s = s.replace(/[\r\n]+/g, ""); // remove trailing CR/LF

  // YYYYMMDDTHHMMSSZ  ->  YYYY-MM-DDTHH:MM:SSZ
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);

  // YYYYMMDDTHHMMZ (no seconds)
  const m2 = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/);
  if (m2) return new Date(`${m2[1]}-${m2[2]}-${m2[3]}T${m2[4]}:${m2[5]}:00Z`);

  // fallback to Date parsing
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function getEventType(
  summary: string
):
  | "Practice 1"
  | "Practice 2"
  | "Practice 3"
  | "Qualifying"
  | "Sprint Qualification"
  | "Sprint Race"
  | "Race"
  | "Other" {
  const summaryLower = summary.toLowerCase();

  if (summaryLower.includes("practice 1")) {
    return "Practice 1";
  } else if (summaryLower.includes("practice 2")) {
    return "Practice 2";
  } else if (summaryLower.includes("practice 3")) {
    return "Practice 3";
  } else if (summaryLower.includes("qualifying")) {
    return "Qualifying";
  } else if (summaryLower.includes("sprint qualification")) {
    return "Sprint Qualification";
  } else if (summaryLower.includes("sprint race")) {
    return "Sprint Race";
  } else if (summaryLower.includes("race")) {
    return "Race";
  }

  return "Other";
}

function getTrack(summary: string): string {
  const regex = /FORMULA 1\s+(.+?)\s+20/i;
  const match = summary.match(regex);

  if (match && match[1]) {
    let circuito = match[1].trim();
    circuito = circuito.replace(/\s\d{4}$/, "").trim();
    return circuito;
  }

  return "";
}

async function getEvents() {
  const calendarUrl = process.env.CALENDAR_URL;

  const response = await axios.get(calendarUrl ?? "");
  const calendarData = response.data;

  const events = ical.parseICS(calendarData);

  const formattedEvents: IcalEvent[] = [];
  const now = new Date();

  for (let eventId in events) {
    const event = events[eventId];
    if (!event.start) continue;

    const start = parseIcalDate(event.start);
    if (!start) {
      // console.log("Unparsed event.start:", eventId, event.start);
      continue;
    }

    if (start.getTime() > now.getTime()) {
      formattedEvents.push({
        id: eventId,
        type: getEventType(event.summary || ""),
        start,
        end:
          event.end instanceof Date
            ? (event.end as Date)
            : event.end
              ? (parseIcalDate(event.end) ?? undefined)
              : undefined,
        track: getTrack(event.summary || ""),
        location: event.location || "",
      });
    }
  }
  return formattedEvents;
}

function groupByLocation(formattedEvents: IcalEvent[]) {
  const gruposTemp = new Map<string, EventsByLocation>();

  formattedEvents.forEach((evento) => {
    const { type, track, start, location } = evento;

    if (!gruposTemp.has(track)) {
      gruposTemp.set(track, { track, start, location });
    }

    const grupo = gruposTemp.get(track)!;

    switch (type) {
      case "Practice 1":
        grupo.p1 = evento;
        break;
      case "Practice 2":
        grupo.p2 = evento;
        break;
      case "Practice 3":
        grupo.p3 = evento;
        break;
      case "Qualifying":
        grupo.q = evento;
        break;
      case "Sprint Qualification":
        grupo.sq = evento;
        break;
      case "Sprint Race":
        grupo.sr = evento;
        break;
      case "Race":
        grupo.r = evento;
        break;
    }
  });

  const orderedArray = Array.from(gruposTemp.values()).sort(
    (a: EventsByLocation, b: EventsByLocation) =>
      a.start.getTime() - b.start.getTime()
  );

  return orderedArray;
}

async function calendarHandle(req: Request, res: Response) {
  try {
    const formattedEvents = await getEvents();
    const now = new Date();

    formattedEvents.sort(
      (a: IcalEvent, b: IcalEvent) => a.start.getTime() - b.start.getTime()
    );

    const nextEvent = formattedEvents.length > 0 ? formattedEvents[0] : null;

    const groupsByLocation = groupByLocation(formattedEvents);

    let timeUntilNext = null;

    if (nextEvent) {
      const timeDiff = nextEvent.start.getTime() - now.getTime();
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
      groupsByLocation,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    res.status(500).json({
      success: false,
      error: "Error at calendarHandle.",
      message,
    });
  }
}

async function upcomingHandle(req: Request, res: Response) {
  try {
    const formattedEvents = await getEvents();
    const now = new Date();

    formattedEvents.sort(
      (a: IcalEvent, b: IcalEvent) => a.start.getTime() - b.start.getTime()
    );

    const nextEvent = formattedEvents.length > 0 ? formattedEvents[0] : null;

    let timeUntilNext = null;

    if (nextEvent) {
      const timeDiff = nextEvent.start.getTime() - now.getTime();
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
    const message = error instanceof Error ? error.message : "Unknown error.";
    res.status(500).json({
      success: false,
      error: "Error at upcomingHandle.",
      message,
    });
  }
}

router.get("/", async (req: Request, res: Response) => {
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

router.get("/calendar", calendarHandle);

router.get("/upcoming", upcomingHandle);

router.get("/download-mp3", async (req: Request, res: Response) => {
  try {
    const urlMP3 = req.query.url;
    const idx = req.query.idx;

    if (!urlMP3) {
      return res.status(400).send("URL required.");
    }

    if (!isSafe(urlMP3.toString())) {
      return res.status(400).send("URL not allowed.");
    }

    const response = await axios({
      method: "get",
      url: urlMP3.toString(),
      responseType: "stream",
    });

    const filename = "f1telemetry-audio" + idx + ".mp3";
    res.setHeader("Content-Disposition", "attachment; filename=" + filename);
    res.setHeader("Content-Type", response.headers["content-type"]);

    response.data.pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    res.status(500).send("Error at file download:" + message);
  }
});

export default router;
