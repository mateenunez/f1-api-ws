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
import { F1APIWebSocketsClient } from "./websocketClient";
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

  const response = await axios.get(calendarUrl ?? "", { responseType: "text" });
  const calendarData = response.data;

  if (typeof calendarData !== "string") {
    throw new Error("Calendar fetch did not return text data");
  }

  // Detect accidental HTML responses (some hosts return an HTML error page)
  if (calendarData.trim().startsWith("<")) {
    const preview = calendarData.trim().slice(0, 200);
    throw new Error("Calendar fetch returned HTML instead of ICS: " + preview);
  }

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
  userService: UserService,
  roleService: RoleService,
  websocketClient: F1APIWebSocketsClient | null,
) {
  const router = express.Router();
  const pool = databaseService.getPool();
  const paginationLimit = 50;
  const premiumRoleId = 2;
  const baseRoleId = 1;

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
      version: "1.0.5",
      description:
        "This is a websocket connection for the F1 Telemetry, captures F1 signal and sends the data with no modifications to the client. PERSONAL USE ONLY: This backend service is developed and maintained for personal, non-commercial use only. It is not intended for commercial, business, or lucrative purposes. NO COMMERCIAL INTENT: The owner of this service has no intentions to generate revenue, profit, or commercial gain from this backend. This is a personal project for educational and personal entertainment purposes. NO WARRANTIES: This service is provided \"AS IS\" without any warranties, express or implied. The owner makes no representations about the reliability, accuracy, or completeness of the information provided. LIMITATION OF LIABILITY: The owner of this backend service shall not be held responsible, liable, or accountable for any damages, losses, or consequences arising from the use, misuse, or inability to use this service. Users access and use this service at their own risk. USER RESPONSIBILITY: Users are solely responsible for their use of this service and must comply with all applicable laws and regulations. The owner assumes no responsibility for user actions or the consequences thereof. NO ENDORSEMENT: This service is not affiliated with, endorsed by, or sponsored by Formula 1, FIA, or any official racing organizations. All data and information are obtained from publicly available sources. ACCEPTANCE: By accessing or using this service, you acknowledge that you have read, understood, and agree to these terms. If you do not agree, please do not use this service.",
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
        name: "Settings",
        description: "Runtime-configurable feature settings (admin only)",
      },
      {
        name: "Users",
        description: "User authentication and management",
      },
      {
        name: "Bridge",
        description: "Bridge connection control endpoints",
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
      "/settings/full-data-roles": {
        get: {
          tags: ["Settings"],
          summary:
            "Get roles that receive full telemetry data (transcriptions/translations) (admin only)",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Current role configuration",
              content: {
                "application/json": {
                  example: {
                    success: true,
                    roleIds: [1, 2, 3],
                    roles: [
                      { id: 1, name: "base" },
                      { id: 2, name: "premium" },
                      { id: 3, name: "admin" },
                    ],
                  },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden - admin role required" },
          },
        },
        put: {
          tags: ["Settings"],
          summary:
            "Set which roles receive full telemetry data (admin only)",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    roleIds: {
                      type: "array",
                      items: { type: "integer" },
                      example: [2, 3],
                    },
                  },
                  required: ["roleIds"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Updated role configuration" },
            "400": { description: "Bad request - invalid role IDs" },
            "401": { description: "Unauthorized" },
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
      "/admin/bridge/reset-reconnect": {
        post: {
          tags: ["Bridge"],
          summary: "Reset websocket bridge reconnect attempts (admin only)",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "Reconnect attempts reset" },
            "400": { description: "Bridge client unavailable" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden - admin role required" },
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
      "/users/find-by-username/{username}": {
        get: {
          tags: ["Users"],
          summary: "Find a user by its username (admin only)",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "username",
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
      "/users/base": {
        get: {
          tags: ["Users"],
          summary: "Get base users with pagination (admin only)",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "page",
              in: "query",
              description: "Page number to retrieve",
              required: false,
              schema: {
                type: "integer",
                default: 1,
              },
            },
          ],
          responses: {
            "200": {
              description: "Base users retrieved successfully",
              content: {
                "application/json": {
                  example: {
                    success: true,
                    count: 120,
                    totalPages: 3,
                    currentPage: 1,
                    users: [],
                  },
                },
              },
            },
            "401": { description: "Unauthorized - token required" },
            "403": { description: "Forbidden - admin role required" },
            "500": { description: "Internal server error" },
          },
        },
      },
      "/users/premium": {
        get: {
          tags: ["Users"],
          summary: "Get premium users with pagination (admin only)",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "page",
              in: "query",
              description: "Page number to retrieve",
              required: false,
              schema: {
                type: "integer",
                default: 1,
              },
            },
          ],
          responses: {
            "200": {
              description: "Premium users retrieved successfully",
              content: {
                "application/json": {
                  example: {
                    success: true,
                    count: 45,
                    totalPages: 1,
                    currentPage: 1,
                    users: [],
                  },
                },
              },
            },
            "401": { description: "Unauthorized - token required" },
            "403": { description: "Forbidden - admin role required" },
            "500": { description: "Internal server error" },
          },
        },
      },

      "/users": {
        get: {
          tags: ["Users"],
          summary: "Get registered users with pagination (admin only)",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "page",
              in: "query",
              description: "Number of the page to retrieve",
              required: false,
              schema: {
                type: "integer",
                default: 1,
              },
            },
          ],
          responses: {
            "200": {
              description: "Paginated list of users",
              content: {
                "application/json": {
                  example: {
                    success: true,
                    count: 154,
                    totalPages: 4,
                    currentPage: 1,
                    users: [],
                  },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden" },
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

  router.get("/", (req: Request, res: Response) =>   res.json({
    message: "F1 Telemetry API is running.",
    swagger: "/swagger",
  }));

  router.use(
    "/swagger",
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      swaggerOptions: {
        // Keeps the entered Bearer token in the browser across page
        // reloads, so it only needs to be pasted in once per 7-day token
        // lifetime instead of on every visit.
        persistAuthorization: true,
      },
    }),
  );

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

  // GET /settings/full-data-roles - Roles that receive full telemetry data (admin only)
  router.get("/settings/full-data-roles", async (req: Request, res: Response) => {
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

      const [roleIds, roles] = await Promise.all([
        roleService.getFullDataRoleIds(),
        roleService.getAllRoles(),
      ]);

      res.json({ success: true, roleIds, roles });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // PUT /settings/full-data-roles - Set which roles receive full telemetry data (admin only)
  router.put("/settings/full-data-roles", async (req: Request, res: Response) => {
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

      const { roleIds } = req.body;
      if (
        !Array.isArray(roleIds) ||
        roleIds.length === 0 ||
        roleIds.some((id: any) => typeof id !== "number" || isNaN(id))
      ) {
        return res.status(400).json({
          success: false,
          error: "roleIds must be a non-empty array of integers",
        });
      }

      const updatedRoleIds = await roleService.setFullDataRoles(roleIds);
      res.json({ success: true, roleIds: updatedRoleIds });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  });

  router.post("/admin/bridge/reset-reconnect", async (req: Request, res: Response) => {
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

      if (!websocketClient) {
        return res
          .status(400)
          .json({
            success: false,
            error: "Websocket bridge client unavailable",
          });
      }

      websocketClient.resetReconnectAttempts();
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
      const result = await userService.verifyToken(token);
      if (!result) {
        return res.status(401).json({ success: false, error: "Invalid token" });
      }
      res.json({ success: true, user: result.user, token: result.token });
    } catch (err) {
      res.status(401).json({ success: false, error: (err as Error).message });
    }
  });

  // Helper function to verify admin role
  async function verifyAdminRole(token: string): Promise<boolean> {
    try {
      const result = await userService.verifyToken(token);
      if (!result) return false;
      return result.user.role.id === 3;
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
      const page = parseInt(req.query.page as string) || 1;

      const { users, totalCount } = await userService.getAllUsersPaginated(
        page,
        paginationLimit,
      );
      const totalPages = Math.ceil(totalCount / paginationLimit);

      res.json({
        success: true,
        count: totalCount,
        totalPages: totalPages,
        currentPage: page,
        users,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // GET /users/base - Get all base users (admin only)
  router.get("/users/base", async (req: Request, res: Response) => {
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
      const page = parseInt(req.query.page as string) || 1;

      const { users, totalCount } = await userService.getUsersByRolePaginated(
        baseRoleId,
        page,
        paginationLimit,
      );
      const totalPages = Math.ceil(totalCount / paginationLimit);

      res.json({
        success: true,
        count: totalCount,
        totalPages: totalPages,
        currentPage: page,
        users,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // GET /users/premium - Get all premium users (admin only)
  router.get("/users/premium", async (req: Request, res: Response) => {
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

      const page = parseInt(req.query.page as string) || 1;

      const { users, totalCount } = await userService.getUsersByRolePaginated(
        premiumRoleId,
        page,
        paginationLimit,
      );
      const totalPages = Math.ceil(totalCount / paginationLimit);

      res.json({
        success: true,
        count: totalCount,
        totalPages: totalPages,
        currentPage: page,
        users,
      });
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
        if (user) delete user.password_hash;
        res.json({ success: true, user });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    },
  );

  // GET /users/find-by-username/:username - Find a user by its username (admin only)
  router.get(
    "/users/find-by-username/:username",
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

        const userUsername = req.params.username;
        if (!userUsername) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid user username" });
        }
        const user = await userService.findByUsername(userUsername);
        if (user) delete user.password_hash;
        res.json({ success: true, user });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, error: (error as Error).message });
      }
    },
  );

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

  return router;
}
