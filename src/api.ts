// api.js
import express from "express";
import dotenv from "dotenv";
dotenv.config();
import ical from "ical";
import axios from "axios";
import { Response, Request } from "express";
import { DatabaseService } from "./databaseService";
import { RoleService } from "./roleService";
import { UserService } from "./userService";
import { RedisClient } from "./redisClient";
import swaggerUi from "swagger-ui-express";

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
  summary: string,
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
      a.start.getTime() - b.start.getTime(),
  );

  return orderedArray;
}

export default function (
  databaseService: DatabaseService,
  redisClient: RedisClient,
) {
  const router = express.Router();
  const pool = databaseService.getPool();
  const roleService = new RoleService(pool);
  const userService = new UserService(pool);

  async function calendarHandle(req: Request, res: Response) {
    try {
      const formattedEvents = await getEvents();
      const now = new Date();

      formattedEvents.sort(
        (a: IcalEvent, b: IcalEvent) => a.start.getTime() - b.start.getTime(),
      );

      const nextEvent = formattedEvents.length > 0 ? formattedEvents[0] : null;

      const groupsByLocation = groupByLocation(formattedEvents);

      let timeUntilNext = null;

      if (nextEvent) {
        const timeDiff = nextEvent.start.getTime() - now.getTime();
        const days = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
        const hours = Math.floor(
          (timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
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
        (a: IcalEvent, b: IcalEvent) => a.start.getTime() - b.start.getTime(),
      );

      const nextEvent = formattedEvents.length > 0 ? formattedEvents[0] : null;

      let timeUntilNext = null;

      if (nextEvent) {
        const timeDiff = nextEvent.start.getTime() - now.getTime();
        const days = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
        const hours = Math.floor(
          (timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
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

  const swaggerSpec: any = {
    openapi: "3.0.0",
    info: {
      title: "F1 Telemetry API",
      version: "1.0.0",
      description:
        "APIs for calendar, DB ping, roles and user auth (register/login).",
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JWT token obtained from /users/login endpoint",
        },
      },
    },
    tags: [
      {
        name: "Calendar",
        description: "F1 calendar and event management",
      },
      {
        name: "Database",
        description: "Database health check",
      },
      {
        name: "Roles",
        description: "Role management endpoints",
      },
      {
        name: "Users",
        description: "User authentication and management",
      },
      {
        name: "Media",
        description: "Media file download",
      },
    ],
    paths: {
      "/db/ping": {
        get: {
          tags: ["Database"],
          summary: "DB ping",
          responses: {
            "200": { description: "OK" },
            "500": { description: "Error" },
          },
        },
      },
      "/roles/{id}": {
        get: {
          tags: ["Roles"],
          summary: "Get role by id",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": { description: "Role found" },
            "404": { description: "Not found" },
          },
        },
      },
      "/roles/update-cooldown": {
        post: {
          tags: ["Roles"],
          summary: "Update role cooldown (admin only)",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    newCooldown: { type: "integer" },
                  },
                  required: ["name", "newCooldown"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Updated" },
            "400": { description: "Bad request" },
            "401": { description: "Unauthorized - token required" },
            "403": { description: "Forbidden - admin role required" },
          },
        },
      },
      "/users/register": {
        post: {
          tags: ["Users"],
          summary: "Register user",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    username: { type: "string" },
                    email: { type: "string", format: "email" },
                    password: { type: "string" },
                  },
                  required: ["username", "email", "password"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Registered" },
            "400": { description: "Bad request" },
          },
        },
      },
      "/users/login": {
        post: {
          tags: ["Users"],
          summary: "Login user",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string" },
                  },
                  required: ["email", "password"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Authenticated" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/users/verify-token": {
        post: {
          tags: ["Users"],
          summary: "Verify user token",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { type: "string" },
                  },
                  required: ["token"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Authenticated" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/users/find-by-email/{email}": {
        get: {
          tags: ["Users"],
          summary: "Find a user by its email (admin only)",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "email",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "User found succesfully" },
            "401": { description: "Unauthorized - token required" },
            "403": { description: "Forbidden - admin role required" },
          },
        },
      },
      "/users/active": {
        get: {
          tags: ["Users"],
          summary: "Find chat active users (admin only)",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "Active users retrieved successfully" },
            "401": { description: "Unauthorized - token required" },
            "403": { description: "Forbidden - admin role required" },
          },
        },
      },
      "/users": {
        get: {
          tags: ["Users"],
          summary: "Get all registered users (admin only)",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "List of users retrieved successfully" },
            "401": { description: "Unauthorized - token required" },
            "403": { description: "Forbidden - admin role required" },
          },
        },
      },
      "/users/block/{id}": {
        post: {
          tags: ["Users"],
          summary: "Block a user by setting big cooldown (admin only)",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": { description: "User blocked successfully" },
            "401": { description: "Unauthorized - token required" },
            "403": { description: "Forbidden - admin role required" },
            "400": { description: "Bad request - invalid user ID" },
          },
        },
      },
      "/users/{id}": {
        delete: {
          tags: ["Users"],
          summary: "Delete a user (admin only)",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": { description: "User deleted successfully" },
            "401": { description: "Unauthorized - token required" },
            "403": { description: "Forbidden - admin role required" },
            "404": { description: "User not found" },
            "400": { description: "Bad request - invalid user ID" },
          },
        },
      },
      "/users/{id}/role": {
        post: {
          tags: ["Users"],
          summary: "Change user role (admin only)",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    roleId: { type: "integer" },
                  },
                  required: ["roleId"],
                },
              },
            },
          },
          responses: {
            "200": { description: "User role updated successfully" },
            "400": { description: "Bad request - invalid user ID or role ID" },
            "401": { description: "Unauthorized - token required" },
            "403": { description: "Forbidden - admin role required" },
            "404": { description: "User or role not found" },
          },
        },
      },
      "/calendar": {
        get: {
          tags: ["Calendar"],
          summary: "Get calendar events",
        },
      },
      "/upcoming": {
        get: {
          tags: ["Calendar"],
          summary: "Get upcoming event",
        },
      },
    },
  };

  // mount swagger UI at /swagger
  router.use("/swagger", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  router.get("/", async (req: Request, res: Response) => {
    res.send(`
      <!DOCTYPE html>
      <html lang="es">
        <head>
          <meta charset="UTF-8" />
          <title>F1 WebSocket Proxy</title>
          <style>
            :root { --bg: #1c2022; --card: #ffffff; --muted: #c7d0da; --accent: #4ab855; }
            body { font-family: Arial, sans-serif; background: linear-gradient(180deg,var(--bg),#0b1220); color: var(--muted); margin: 0; padding: 40px; }
            .container { max-width: 900px; margin: auto; background: #1c2022; border-radius: 8px; padding: 28px; box-shadow: 0 6px 24px rgba(2,6,23,0.6);}
            h1 { color: var(--card); margin: 0 0 10px 0; font-size: 28px; }
            .status { font-size: 0.95em; margin-top: 12px; color: #7ef0a6; }
            .description { font-size: 0.95em; margin-top: 20px; line-height:1.5; }
            a.docs { display:inline-block; margin-top:20px; padding:10px 14px; background: var(--accent); color:#fff; text-decoration:none; border-radius:6px;}
            .legal { margin-top:18px; background: #1c2022; padding:12px; border-radius:6px; color:var(--muted); font-size:0.86em;}
            .legal h3 { color: #a9d0ff; margin:0 0 6px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>F1 Websocket Proxy</h1>
            <div class="status">WebSocket active</div>
            <div class="description">
              <div>This is a websocket connection for the F1 Telemetry, captures F1 signal and sends the data with no modifications to the client.</div>
              <div>This websocket doesn't need authorization; if you found this websocket and want to get the information please consider notifying the owner to preserve free hosting.</div>
              <a class="docs" href="/swagger">Open API Docs (Swagger UI)</a>
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

  router.get("/db/ping", async (req: Request, res: Response) => {
    try {
      const result = await pool.query("SELECT 1 as ok");
      res.json({ success: true, db: result.rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.get("/roles/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const role = await roleService.getRoleById(id);
      if (!role)
        return res
          .status(404)
          .json({ success: false, error: "Role not found" });
      res.json({ success: true, role });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.post("/roles/update-cooldown", async (req: Request, res: Response) => {
    try {
      const token = req.headers.authorization?.split(" ")[1];
      if (!token) {
        return res
          .status(401)
          .json({ success: false, error: "Authorization token required" });
      }

      const isAdmin = await verifyAdminRole(token);
      if (!isAdmin) {
        return res
          .status(403)
          .json({ success: false, error: "Admin role required" });
      }

      const { name, newCooldown } = req.body;
      if (!name || typeof newCooldown !== "number") {
        return res
          .status(400)
          .json({ success: false, error: "name and newCooldown required" });
      }
      await roleService.updateRoleCooldown(name, newCooldown);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.post("/users/register", async (req: Request, res: Response) => {
    try {
      const { username, email, password } = req.body;
      if (!username || !email || !password) {
        return res.status(400).json({
          success: false,
          error: "VALIDATION_REQUIRED",
        });
      }
      const result = await userService.register(username, email, password);
      // result contains { user, token }
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.post("/users/login", async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res
          .status(400)
          .json({ success: false, error: "VALIDATION_REQUIRED" });
      }
      const result = await userService.login(email, password);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(401).json({ success: false, error: (err as Error).message });
    }
  });

  router.post("/users/verify-token", async (req: Request, res: Response) => {
    try {
      const token = req.body.token;
      if (!token) {
        return res
          .status(400)
          .json({ success: false, error: "token required" });
      }
      const user = await userService.verifyToken(token);
      res.json({ success: true, user });
    } catch (err) {
      res.status(401).json({ success: false, error: (err as Error).message });
    }
  });

  // Admin-only endpoints

  // Helper function to verify admin role
  async function verifyAdminRole(token: string): Promise<boolean> {
    try {
      const user = await userService.verifyToken(token);
      return user.role.name === "admin";
    } catch {
      return false;
    }
  }

  // GET /users - Get all registered users (admin only)
  router.get("/users", async (req: Request, res: Response) => {
    try {
      const token = req.headers.authorization?.split(" ")[1];
      if (!token) {
        return res
          .status(401)
          .json({ success: false, error: "Authorization token required" });
      }

      const isAdmin = await verifyAdminRole(token);
      if (!isAdmin) {
        return res
          .status(403)
          .json({ success: false, error: "Admin role required" });
      }

      const users = await userService.getAllUsers();
      res.json({ success: true, users });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // GET /users/find-by-email/:email - Find a user by its email (admin only)
  router.get(
    "/users/find-by-email/:email",
    async (req: Request, res: Response) => {
      try {
        const token = req.headers.authorization?.split(" ")[1];
        if (!token) {
          return res
            .status(401)
            .json({ success: false, error: "Authorization token required" });
        }

        const isAdmin = await verifyAdminRole(token);
        if (!isAdmin) {
          return res
            .status(403)
            .json({ success: false, error: "Admin role required" });
        }

        const userEmail = req.params.email;
        if (!userEmail) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid user email" });
        }
        const user = await userService.findByEmail(userEmail);
        console.log(user);
        res.json({ success: true, user });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    },
  );

  // POST /users/block/:id - Block a user by setting big cooldown (admin only)
  router.post("/users/block/:id", async (req: Request, res: Response) => {
    try {
      const token = req.headers.authorization?.split(" ")[1];
      if (!token) {
        return res
          .status(401)
          .json({ success: false, error: "Authorization token required" });
      }

      const isAdmin = await verifyAdminRole(token);
      if (!isAdmin) {
        return res
          .status(403)
          .json({ success: false, error: "Admin role required" });
      }

      const userId = Number(req.params.id);
      if (isNaN(userId)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid user ID" });
      }

      // Set a very large cooldown (1 year in seconds)
      const oneYearInSeconds = 365 * 24 * 60 * 60;
      await redisClient.setCooldown(userId, oneYearInSeconds);

      res.json({ success: true, message: `User ${userId} has been blocked` });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // DELETE /users/:id - Delete a user (admin only)
  router.delete("/users/:id", async (req: Request, res: Response) => {
    try {
      const token = req.headers.authorization?.split(" ")[1];
      if (!token) {
        return res
          .status(401)
          .json({ success: false, error: "Authorization token required" });
      }

      const isAdmin = await verifyAdminRole(token);
      if (!isAdmin) {
        return res
          .status(403)
          .json({ success: false, error: "Admin role required" });
      }

      const userId = Number(req.params.id);
      if (isNaN(userId)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid user ID" });
      }

      const deletedUser = await userService.deleteUser(userId);
      if (!deletedUser) {
        return res
          .status(404)
          .json({ success: false, error: "User not found" });
      }

      res.json({ success: true, message: `User ${userId} has been deleted` });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // POST /users/:id/role - Change user role (admin only)
  router.post("/users/:id/role", async (req: Request, res: Response) => {
    try {
      const token = req.headers.authorization?.split(" ")[1];
      if (!token) {
        return res
          .status(401)
          .json({ success: false, error: "Authorization token required" });
      }

      const isAdmin = await verifyAdminRole(token);
      if (!isAdmin) {
        return res
          .status(403)
          .json({ success: false, error: "Admin role required" });
      }

      const userId = Number(req.params.id);
      if (isNaN(userId)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid user ID" });
      }

      const { roleId } = req.body;
      if (typeof roleId !== "number" || isNaN(roleId)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid role ID" });
      }

      const updatedUser = await userService.updateUserRole(userId, roleId);
      if (!updatedUser) {
        return res
          .status(404)
          .json({ success: false, error: "User or role not found" });
      }

      res.json({
        success: true,
        message: `User ${userId} role updated`,
        user: updatedUser,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.get("/users/active", async (req: Request, res: Response) => {
    try {
      const token = req.headers.authorization?.split(" ")[1];
      if (!token) {
        return res
          .status(401)
          .json({ success: false, error: "Authorization token required" });
      }

      const isAdmin = await verifyAdminRole(token);
      if (!isAdmin) {
        return res
          .status(403)
          .json({ success: false, error: "Admin role required" });
      }

      const activeUsersStats = await redisClient.getActiveUsersStats();
      res.json({ success: true, activeUsersStats });
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  return router;
}
