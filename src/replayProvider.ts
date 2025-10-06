import * as fs from 'fs';
import * as readlinePromises from 'readline/promises';

import { StateProcessor } from './stateProcessor';
import { EventEmitter } from 'stream';

async function readReplayFile(filePath: string) {
    const readLine = readlinePromises.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity
    });

    const lines: any[] = []
    for await (const line of readLine) {
        lines.push(JSON.parse(line));
    }
    return lines;
}

export class ReplayProvider extends EventEmitter {
    constructor(private filePath: string, private stateProcessor: StateProcessor, private fastForwardSeconds: number = 0) {
        super();
        this.setMaxListeners(0);
    }

    async run(): Promise<void> {
        const lines = await readReplayFile(this.filePath);
        const initialStateJson = lines[0]

        const originalStartDate = new Date(initialStateJson.R.SessionInfo.StartDate);
        const originalEndDate = new Date(initialStateJson.R.SessionInfo.EndDate);

        const now = new Date();
        const adjustedStartDate = new Date(now.getTime() - this.fastForwardSeconds * 1000);
        const adjustedEndDate = new Date(adjustedStartDate.getTime() + (originalEndDate.getTime() - originalStartDate.getTime()));

        initialStateJson.R.SessionInfo.StartDate = adjustedStartDate.toISOString();
        initialStateJson.R.SessionInfo.EndDate = adjustedEndDate.toISOString();
        initialStateJson.R.SessionInfo.GmtOffset = "00:00:00";

        // Initialize state with the first line
        this.stateProcessor.updateState(lines.shift());
        const firstMessageTimestamp = Date.parse(lines[0].M[0].A[2]);

        let lastProcessedTimestamp = firstMessageTimestamp;

        let firstQueuedMessageTimestamp: number | undefined = undefined;

        for await (const line of lines) {
            if (line.M) {
                const messageTimestamp = Date.parse(line.M[0].A[2]);
                if ((messageTimestamp - firstMessageTimestamp) < this.fastForwardSeconds * 1000) {
                    // Greedyly process messages until we reach the fast-forward threshold
                    lastProcessedTimestamp = messageTimestamp;
                    this.stateProcessor.processFeed(line.M[0].A[0], line.M[0].A[1], line.M[0].A[2]);
                } else {
                    if (!firstQueuedMessageTimestamp) {
                        firstQueuedMessageTimestamp = lastProcessedTimestamp;
                    }
                    setTimeout(() => {
                        this.stateProcessor.processFeed(line.M[0].A[0], line.M[0].A[1], line.M[0].A[2]);
                        this.emit('broadcast', Buffer.from(JSON.stringify(line)));
                    }, messageTimestamp - firstQueuedMessageTimestamp!);
                }
            }
        }
    }
}