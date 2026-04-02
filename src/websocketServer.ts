import { Server as HttpServer } from "http";
import { StateProvider } from "./stateProcessor";
import { WebSocket, WebSocketServer } from "ws";
import EventEmitter from "events";
import { RedisClient } from "./redisClient";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import cbor from "cbor2";
import { UserService } from "./userService";

interface AuthenticatedSocket extends WebSocket {
  user?: any;
  isAuthenticated?: boolean;
}

class WebSocketTelemetryServer {
  private wss: WebSocketServer;
  private window = new JSDOM("").window;
  private DOMPurify = createDOMPurify(this.window);

  private encodeCBOR(value: any): Buffer {
    return Buffer.from(cbor.encode(value));
  }

  private normalizeOutgoingMessage(data: any): Buffer {
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
      try {
        cbor.decode(data);
        return Buffer.from(data);
      } catch {
        try {
          const parsed = JSON.parse(Buffer.from(data).toString());
          return this.encodeCBOR(parsed);
        } catch {
          return this.encodeCBOR(Buffer.from(data).toString());
        }
      }
    }

    if (typeof data === "string") {
      try {
        return this.encodeCBOR(JSON.parse(data));
      } catch {
        return this.encodeCBOR(data);
      }
    }

    return this.encodeCBOR(data);
  }

  private decodeWebSocketMessage(rawData: any): any {
    const buffer = Buffer.isBuffer(rawData)
      ? rawData
      : rawData instanceof ArrayBuffer
      ? Buffer.from(rawData)
      : Array.isArray(rawData)
      ? Buffer.concat(rawData.map((chunk) => Buffer.from(chunk)))
      : Buffer.from(rawData.toString());

    try {
      return cbor.decode(buffer);
    } catch {
      const text = buffer.toString();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }

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
          try {
            ws.send(this.normalizeOutgoingMessage(data));
          } catch (err) {
            console.error("Error sending broadcast message:", err);
          }
        }
      };

      console.log("Clients connected: " + this.wss.clients.size);

      const snapshot = this.stateProcessor.getState();

      if (snapshot != null) {
        const buffer = this.encodeCBOR(snapshot);
        eventListener(buffer);
      }

      eventBus.on("broadcast", eventListener);

      ws.on("message", async (rawData) => {
        try {
          const data = this.decodeWebSocketMessage(rawData);

          switch (data.type) {
            case "auth:token":
              try {
                const token = data.payload.token;
                if (!token) {
                  ws.send(this.encodeCBOR({ error: "No token given." }));
                }

                const user = await this.userService.verifyToken(token);
                if (!user) {
                  ws.send(this.encodeCBOR({ error: "Invalid token" }));
                  return;
                }
                ws.user = user;
                ws.isAuthenticated = true;

                ws.send(
                  this.encodeCBOR({
                    success: true,
                    message: "Authenticated",
                  }),
                );
              } catch (error) {
                ws.isAuthenticated = false;
                ws.send(this.encodeCBOR({ error: "Invalid token" }));
                console.log("Authentication failed.");
              }
              break;

            case "chat:post": {
              const { content, language } = data.payload || {};

              if (!ws.isAuthenticated || !ws.user) {
                ws.send(this.encodeCBOR({ error: "Authentication required" }));
                return;
              }

              if (
                !content ||
                typeof content !== "string" ||
                content.trim().length === 0
              ) {
                ws.send(this.encodeCBOR({ error: "Message is empty" }));
                return;
              }

              if (content.length > 200) {
                ws.send(this.encodeCBOR({ error: "Message too long" }));
                return;
              }

              const hasCooldown = await redis.hasCooldown(ws.user.id);
              if (hasCooldown) {
                ws.send(this.encodeCBOR({ error: "Cooldown active" }));
                return;
              }

              const lang = language === "es" ? "es" : "en";

              const chatPayload = {
                id: crypto.randomUUID(),
                content: this.sanitize(content),
                user: {
                  id: ws.user.id,
                  username: ws.user.username,
                  color: data.payload.color,
                  badge: data.payload.badge,
                  role_id: ws.user.role.id,
                },
                language: lang,
                cooldown: ws.user.role.cooldown_ms,
                timestamp: new Date().toISOString(),
              };

              if (
                chatPayload.user.color !== ws.user.chat_color ||
                chatPayload.user.badge !== ws.user.chat_badge
              ) {
                // update in database
                await this.userService.updateUserAppearance(
                  ws.user.id,
                  chatPayload.user.color,
                  chatPayload.user.badge,
                );
              }

              const eventName =
                lang === "es" ? "ChatMessageEs" : "ChatMessageEn";

              const telemetryMessage = {
                M: [
                  {
                    H: "Streaming",
                    M: "feed",
                    A: [eventName, chatPayload, new Date().toISOString()],
                  },
                ],
              };

              // set cooldown in seconds
              redis.setCooldown(ws.user.id, ws.user.role.cooldown_ms / 1000);
              // set user as active
              redis.setChatActivity(ws.user.id, ws.user.role.name);
              // save chat message
              this.stateProcessor.saveChatMessage(chatPayload, eventName);
              // broadcast
              eventBus.emit("broadcast", this.encodeCBOR(telemetryMessage));
              break;
            }
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
