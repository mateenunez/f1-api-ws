import { Server as HttpServer } from "http";
import { StateProvider } from "./stateProcessor";
import { WebSocket, WebSocketServer } from "ws";
import EventEmitter from "events";
import { RedisClient } from "./redisClient";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { UserService } from "./userService";

interface AuthenticatedSocket extends WebSocket {
  user?: any;
  isAuthenticated?: boolean;
}

class WebSocketTelemetryServer {
  private wss: WebSocketServer;
  private window = new JSDOM("").window;
  private DOMPurify = createDOMPurify(this.window);

  constructor(
    server: HttpServer,
    private stateProcessor: StateProvider,
    eventBus: EventEmitter,
    redis: RedisClient,
    private userService: UserService,
  ) {
    if (!server) {
      throw new Error(
        "WebSocketServer requires an HTTP server as the first argument.",
      );
    }

    this.wss = new WebSocketServer({ server, clientTracking: true });
    this.wss.on("connection", (ws: AuthenticatedSocket) => {
      const eventListener = (data: any) => {
        if (ws.readyState === WebSocket.OPEN) {
          const message = typeof data === "string" ? data : data.toString();
          ws.send(message);
        }
      };

      console.log("Clients connected: " + this.wss.clients.size);

      const snapshot = this.stateProcessor.getState();

      if (snapshot != null) {
        const buffer = Buffer.from(JSON.stringify(snapshot));
        eventListener(buffer);
      }

      eventBus.on("broadcast", eventListener);

      ws.on("message", async (rawData) => {
        try {
          const data = JSON.parse(rawData.toString());

          switch (data.type) {
            case "auth:token":
              try {
                const token = data.payload.token;
                if (!token) {
                  ws.send(JSON.stringify({ error: "No token given." }));
                }

                const user = await this.userService.verifyToken(token);
                if (!user) {
                  ws.send(JSON.stringify({ error: "Invalid token" }));
                  return;
                }
                ws.user = user;
                ws.isAuthenticated = true;

                ws.send(
                  JSON.stringify({
                    success: true,
                    message: "Authenticated",
                  }),
                );
                console.log(`User ${user.username} authenticated on WebSocket`);
                console.log(user);
              } catch (error) {
                ws.isAuthenticated = false;
                ws.send(JSON.stringify({ error: "Invalid token" }));
                console.log("Authentication failed.");
              }
              break;

            case "joke:post":
              const { content, xPct, yPct, color } = data.payload;
              console.log(data);
              if (!ws.isAuthenticated || !ws.user) {
                ws.send(JSON.stringify({ error: "Authentication required" }));
                return;
              }

              if (!content || content.length > 150) {
                console.log("Joke is too long or empty.");
                return;
              }

              const hasCooldown = await redis.hasCooldown(ws.user.id);
              if (hasCooldown) {
                ws.send(JSON.stringify({ error: "Cooldown active" }));
                return;
              }

              const jokePayload = {
                id: crypto.randomUUID(),
                content: this.sanitize(content),
                coords: { xPct, yPct },
                cooldown: ws.user.role.cooldown_ms,
                color: color || "#FFFFFF",
                user: {
                  id: ws.user.id,
                  username: ws.user.username,
                }
              };

              const telemetryMessage = {
                M: [
                  {
                    H: "Streaming",
                    M: "feed",
                    A: [
                      "Joke", 
                      jokePayload,
                      new Date().toISOString(), 
                    ],
                  },
                ],
              };
              redis.setCooldown(ws.user.id, ws.user.role.cooldown_ms / 1000);
              eventBus.emit("broadcast", JSON.stringify(telemetryMessage));
              break;
            default:
              console.log("Unhandled event.", data.type);
          }
        } catch (error) {
          console.error("Error at websocket server message.");
        }
      });

      ws.on("close", () => {
        eventBus.off("broadcast", eventListener);
      });
    });
  }

  sanitize = (content: string): string => {
    return this.DOMPurify.sanitize(content, {
      ALLOWED_TAGS: [],
      ALLOWED_ATTR: [],
    }).trim();
  };
}

export { WebSocketTelemetryServer };
