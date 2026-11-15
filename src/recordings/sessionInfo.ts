/**
 * Helpers for turning the F1 live-timing `SessionInfo` payload into the
 * meeting/session rows used by the replay feature.
 *
 * The payload shape is:
 *   { R: { SessionInfo: { Meeting: {...}, Key, Type, Name, StartDate, ... } } }
 *
 * The recorder in f1-bridge writes that full `R` snapshot as the first JSONL
 * record, so the API can rebuild the association from an uploaded file even
 * when the client does not send any metadata query params.
 */

export type SessionStatus = "scheduled" | "started" | "completed" | "aborted";

export interface MeetingInput {
  meetingKey: number;
  name: string;
  officialName: string | null;
  location: string | null;
  countryKey: number | null;
  countryCode: string | null;
  countryName: string | null;
  circuitKey: number | null;
  circuitShortName: string | null;
  year: number;
}

export interface SessionInput {
  sessionKey: number;
  /** null means the session is detached from any meeting. */
  meetingKey: number | null;
  name: string;
  type: string;
  startDate: string | null;
  endDate: string | null;
  status: SessionStatus;
}

export interface RecordingSessionInfo {
  meeting: MeetingInput;
  session: SessionInput;
}

// SessionInfo is normally in the first line, but scanning a few records makes
// the parser resilient to leading heartbeat/empty records.
const MAX_SESSION_INFO_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_INFO_RECORDS = 200;

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, any>;
}

function toInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function toText(value: unknown, maxLength = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

/**
 * F1 live-timing dates are UTC but may omit the trailing `Z`
 * (e.g. "2026-10-31T11:30:00"). Normalize them before they reach PostgreSQL
 * so the server timezone cannot shift the session date.
 */
export function toIsoDate(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;

  const raw = value.trim();
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
    ? raw
    : /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? `${raw}T00:00:00Z`
      : `${raw}Z`;
  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function isSessionStatus(value: unknown): value is SessionStatus {
  return (
    value === "scheduled" ||
    value === "started" ||
    value === "completed" ||
    value === "aborted"
  );
}

/**
 * Accepts either the full snapshot (`{ R: { SessionInfo } }`) or the
 * `SessionInfo` node itself. Returns null when the payload does not contain
 * the F1 keys needed to associate a recording.
 */
export function normalizeSessionInfo(
  state: unknown,
  options: { status?: SessionStatus } = {},
): RecordingSessionInfo | null {
  const root = asRecord(state);
  if (!root) return null;

  const sessionInfoNode =
    asRecord(asRecord(root.R)?.SessionInfo) ?? asRecord(root.SessionInfo);
  if (!sessionInfoNode) return null;

  const meetingNode = asRecord(sessionInfoNode.Meeting);
  if (!meetingNode) return null;

  const meetingKey = toInteger(meetingNode.Key);
  const sessionKey = toInteger(sessionInfoNode.Key);
  if (meetingKey === null || sessionKey === null) return null;

  const meetingName = toText(meetingNode.Name, 200);
  const sessionName =
    toText(sessionInfoNode.Name, 200) ??
    toText(sessionInfoNode.Type, 100) ??
    "Session";
  const sessionType = toText(sessionInfoNode.Type, 100) ?? sessionName;

  const country = asRecord(meetingNode.Country);
  const circuit = asRecord(meetingNode.Circuit);

  const startDate = toIsoDate(sessionInfoNode.StartDate);
  const endDate = toIsoDate(sessionInfoNode.EndDate);
  const year = startDate
    ? new Date(startDate).getUTCFullYear()
    : new Date().getUTCFullYear();

  return {
    meeting: {
      meetingKey,
      name: meetingName ?? `Meeting ${meetingKey}`,
      officialName: toText(meetingNode.OfficialName, 300),
      location: toText(meetingNode.Location, 200),
      countryKey: toInteger(country?.Key),
      countryCode: toText(country?.Code, 10),
      countryName: toText(country?.Name, 100),
      circuitKey: toInteger(circuit?.Key),
      circuitShortName: toText(circuit?.ShortName, 100),
      year,
    },
    session: {
      sessionKey,
      meetingKey,
      name: sessionName,
      type: sessionType,
      startDate,
      endDate,
      status: options.status ?? "completed",
    },
  };
}

/**
 * Reads the beginning of a JSONL recording and returns the first
 * `R.SessionInfo` found. It never parses the whole 9+ MB file: only the first
 * `MAX_SESSION_INFO_SCAN_BYTES`, which is where the recorder writes the state
 * snapshot.
 */
export function extractSessionInfoFromRecording(
  buffer: Buffer,
): RecordingSessionInfo | null {
  if (!buffer || buffer.length === 0) return null;

  const limit = Math.min(buffer.length, MAX_SESSION_INFO_SCAN_BYTES);
  const text = buffer.subarray(0, limit).toString("utf8");
  const lines = text.split("\n");

  // If the scan ended in the middle of a line, ignore that partial line
  // instead of trying to JSON.parse it.
  if (limit < buffer.length) lines.pop();

  for (
    let index = 0;
    index < lines.length && index < MAX_SESSION_INFO_RECORDS;
    index++
  ) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const info = normalizeSessionInfo(JSON.parse(line));
      if (info) return info;
    } catch {
      // A malformed/partial line should not abort the scan.
    }
  }

  // Some manual uploads are a single pretty-printed JSON document instead of
  // JSONL. Try the scanned chunk as one document before giving up.
  try {
    const info = normalizeSessionInfo(JSON.parse(text));
    if (info) return info;
  } catch {
    // Not a single JSON document.
  }

  return null;
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Same filename shape used by f1-bridge
 * (e.g. 2026-mexico-city-grand-prix-practice-3-q1). The future in-process
 * recorder can reuse it so sessionId values stay stable.
 */
export function buildRecordingSlug(
  info: RecordingSessionInfo,
  qualifyingPart: number | null = null,
): string {
  return [
    String(info.meeting.year),
    slugify(info.meeting.name) || String(info.meeting.meetingKey),
    slugify(info.session.name) || slugify(info.session.type) || "session",
    qualifyingPart ? `q${qualifyingPart}` : "",
  ]
    .filter(Boolean)
    .join("-");
}
