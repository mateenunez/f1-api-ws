import { Pool } from "pg";
import { EventEmitter } from "stream";

export interface PinnedChatMessage {
  id: number;
  content: string;
  language: string;
  timestamp: Date;
  pinned: boolean;
}

export class ChatService {
  constructor(
    private pool: Pool,
    private eventEmitter: EventEmitter,
  ) {}

  updatePinnedMessages(data: any) {
    const payload = { PinnedMessages: data };
    const pinnedBuffer = Buffer.from(JSON.stringify(payload));
    this.eventEmitter.emit("broadcast", pinnedBuffer);
  }

  async getPinnedMessages(): Promise<PinnedChatMessage[]> {
    const res = await this.pool.query(
      `SELECT id, content, language, timestamp, pinned
       FROM chat_pinned_messages
       WHERE pinned = true
       ORDER BY timestamp DESC`,
    );
    return res.rows;
  }

  async pinMessage(
    language: string,
    content: string,
  ): Promise<PinnedChatMessage | null> {
    const timestamp = new Date();
    const pinned = true;

    try {
      const result = await this.pool.query(
        "INSERT INTO chat_pinned_messages (content, language, timestamp, pinned) VALUES ($1, $2, $3, $4) RETURNING id, content, language, timestamp, pinned",
        [content, language, timestamp, pinned],
      );

      if (result.rows.length === 0) {
        return null;
      }

      // broadcast updated pinned messages to all clients
      const pinnedMessages = await this.getPinnedMessages();
      this.updatePinnedMessages(pinnedMessages);

      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  async unpinAll(language?: string): Promise<boolean> {
    if (language) {
      await this.pool.query(
        "UPDATE chat_pinned_messages SET pinned = FALSE WHERE language = $1",
        [language],
      );
      // broadcast updated pinned messages to all clients
      const pinnedMessages = await this.getPinnedMessages();
      this.updatePinnedMessages(pinnedMessages);
    } else {
      await this.pool.query("UPDATE chat_pinned_messages SET pinned = FALSE");
    }
    return true;
  }
}
