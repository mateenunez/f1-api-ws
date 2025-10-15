import EventEmitter from "events";
import axios, { AxiosError } from "axios";
import WebSocket from "ws";
import { StateProcessor } from "./stateProcessor";
import { HttpTransportType, HubConnection, HubConnectionBuilder, LogLevel } from "@microsoft/signalr";
import { TranslationService } from "./translationService";

class F1APIWebSocketsClient extends EventEmitter {
    private initAttempts = 0;

    constructor(protected readonly stateProcessor: StateProcessor, private translationService: TranslationService, private maxInitAttempts: number = 5) {
        super()
        this.setMaxListeners(0);
    }

    broadcast(data: any) {
        this.emit("broadcast", data);
    }

    async commonNegotiation() {
        try {
            const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
            const url = `https://livetiming.formula1.com/signalr/negotiate?connectionData=${hub}&clientProtocol=1.5`;
            const res = await axios.get(url);
            return res;
        } catch (error) {
            const e: AxiosError = error as AxiosError;
            console.log(
                "Error during negotiation:",
                e.response?.data || e.message
            );
            return Promise.reject(error);
        }

    }

    async commonWebSocketConnection(token: string, cookie: string): Promise<WebSocket> {
        const hub = encodeURIComponent(JSON.stringify([{ name: "Streaming" }]));
        const encodedToken = encodeURIComponent(token);
        const url = `wss://livetiming.formula1.com/signalr/connect?clientProtocol=1.5&transport=webSockets&connectionToken=${encodedToken}&connectionData=${hub}`;
        return new Promise((res, rej) => {
            const sock = new WebSocket(url, {
                headers: {
                    "User-Agent": "BestHTTP",
                    "Accept-Encoding": "gzip,identity",
                    Cookie: cookie,
                },
            });

            sock.on("open", () => {
                res(sock);
            });

            sock.on("message", async (data) => {
                const parsedData = JSON.parse(data.toString());
                if (parsedData.R) {
                    this.stateProcessor.updateState(parsedData);
                    this.stateProcessor.processRaceControlMessagesEs(parsedData.R.RaceControlMessages.Messages);
                    console.log("Basic data subscription fullfilled");
                }

                // Actualizar el estado de la variable on connection data
                if (Array.isArray(parsedData.M)) {
                    parsedData.M.forEach((update: any) => {
                        if (update.H === "Streaming" && update.M === "feed") {
                            const [feedName, data, timestamp] = update.A;

                            const snapshot = this.stateProcessor.getState();
                            if (!snapshot || !snapshot.R) {
                                return;
                            }

                            this.stateProcessor.processFeed(feedName, data, timestamp);

                            if (feedName === "RaceControlMessages") {
                                this.receivedRaceControlMessage(feedName, data, timestamp);
                            }
                        }
                    });
                }

                this.broadcast(data);
            });
        });
    }

    async premiumNegotiation(subscriptionToken: string) {
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
                "Error during premium negotiation:",
                e.response?.data || e.message
            );
            return Promise.reject(error);
        }
    }

    async premiumWebsocketConnect(subscriptionToken: string, cookies: string[]): Promise<HubConnection> {
        const cookieString = cookies
            .map((cookie) => cookie.split(";")[0].trim())
            .join("; ");
        const connection = new HubConnectionBuilder()
            .withUrl("https://livetiming.formula1.com/signalrcore", {
                transport: HttpTransportType.WebSockets,
                accessTokenFactory: () => subscriptionToken,
                headers: {
                    Cookie: cookieString,
                    "User-Agent": "BestHTTP",
                    "Accept-Encoding": "gzip,identity",
                },
            })
            .configureLogging(LogLevel.Information)
            .build();

        connection.on("feed", (feedName, data, timestamp) => {
            this.stateProcessor.processFeed(feedName, data, timestamp);
            const streamingData = {
                M: [{ H: "Streaming", M: "feed", A: [feedName, data, timestamp] }],
            };
            this.broadcast(Buffer.from(JSON.stringify(streamingData)));

            if (feedName === "RaceControlMessages") {
                this.receivedRaceControlMessage(feedName, data, timestamp);
            }
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
                this.stateProcessor.updateStatePremium(subscriptionData);
                this.stateProcessor.processRaceControlMessagesEs(subscriptionData.RaceControlMessages.Messages);
                console.log("Premium data subscription fullfilled.");
            }

            return connection;
        } catch (error) {
            console.error("Connection failed: ", error);
            throw error;
        }
    }

    async receivedRaceControlMessage(feedName: string, data: any, timestamp: string) {
        const raceControlMessage = data;
        let object: any = Object.values(raceControlMessage.Messages)[0];
        const latestMessage: string = object.Message;
        this.translationService.translate(latestMessage).then(
            (translation) => {
                object.Message = translation;

                const translateData = { "Messages": object };
                this.stateProcessor.processFeed(feedName + "Es", translateData, timestamp);

                const streamingData = { "M": [{ "H": "Streaming", "M": "feed", "A": [feedName + "Es", translateData, timestamp] }] }
                this.broadcast(Buffer.from(JSON.stringify(streamingData)));
            }
        );

    }

    async init() {
        try {
            const subscriptionToken = process.env.F1TVSUBSCRIPTION_TOKEN || "";

            try {
                const negotiation = await this.premiumNegotiation(subscriptionToken);

                const cookies = negotiation.headers["set-cookie"] ?? [];

                if (negotiation && negotiation.status === 200) {
                    if (negotiation.headers)
                        await this.premiumWebsocketConnect(
                            subscriptionToken,
                            cookies
                        );
                    return;
                }
            } catch (premiumError) {
                console.warn("Premium connection failed: ", premiumError);
            }

            try {
                console.log("Started common negotiation.");

                const negotiationResponse = await this.commonNegotiation();

                const cookies: string[] = negotiationResponse.headers["set-cookie"] ?? [];

                const cookieString = cookies
                    .map((cookie) => cookie.split(";")[0].trim())
                    .join("; ");

                const sock = await this.commonWebSocketConnection(
                    negotiationResponse.data["ConnectionToken"],
                    cookieString
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
            } catch (commonError) {
                console.error("Common connection failed:", commonError);
            }
        } catch (error) {
            if (this.initAttempts < this.maxInitAttempts) {
                console.log("Attempting to reconnect...");
                const delay = Math.pow(2, this.initAttempts) * 1000
                setTimeout(() => {
                    this.initAttempts++;
                    this.init();
                }, delay);
            } else {
                console.log("Max reconnect attempts reached.", error);
            }
        }
    }
}

export { F1APIWebSocketsClient };