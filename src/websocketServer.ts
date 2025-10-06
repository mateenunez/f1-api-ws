import { Server as HttpServer } from "http";
import { StateProvider } from "./stateProcessor";
import { WebSocket, WebSocketServer } from "ws";
import EventEmitter from "events";

class WebSocketTelemetryServer {
  private wss: WebSocketServer;

  constructor(server: HttpServer, private stateProcessor: StateProvider, eventBus: EventEmitter) {
    if (!server) {
      throw new Error(
        "WebSocketServer requires an HTTP server as the first argument."
      );
    }

    this.wss = new WebSocketServer({ server, clientTracking: true });
    this.wss.on("connection", (ws: WebSocket) => {
      const eventListener = (data: any) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      };

      console.log("Clients connected: " + this.wss.clients.size)

      const snapshot = this.stateProcessor.getState();

      if (snapshot != null) {
        const buffer = Buffer.from(JSON.stringify(snapshot));
        eventListener(buffer);
      }

      eventBus.on('broadcast', eventListener)

      ws.on("close", () => {
        eventBus.off('broadcast', eventListener)
      });
    });
  }
}

export { WebSocketTelemetryServer };
