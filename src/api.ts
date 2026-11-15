// api.js
import express from "express";
import dotenv from "dotenv";
dotenv.config();
import ical from "ical";
import axios from "axios";
import inspector from "inspector";
import fs from "fs";
import os from "os";
import path from "path";
import { Response, Request } from "express";
import { DatabaseService } from "./databaseService";
import { RoleService } from "./roleService";
import { UserService } from "./userService";
import { ConfigService } from "./configService";
import { EmailService } from "./emailService";
import { RedisClient } from "./redisClient";
import { F1APIWebSocketsClient } from "./websocketClient";
import swaggerUi from "swagger-ui-express";
import { createAuthMiddleware } from "./middleware/auth";
import type { StateProcessor } from "./stateProcessor";
import {
  extractSessionInfoFromRecording,
  isSessionStatus,
  toIsoDate,
  type MeetingInput,
  type SessionInput,
  type SessionStatus,
} from "./recordings/sessionInfo";

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

const MAX_RECORDING_BYTES = 50 * 1024 * 1024;
const SESSION_INFO_SCAN_BYTES = 16 * 1024 * 1024;
const RECORDING_SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,234}$/;

class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, any>;
}

function toSafeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new InvalidRequestError(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new InvalidRequestError(
      `${field} must be at most ${maxLength} characters.`,
    );
  }
  return trimmed || null;
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const parsed = optionalString(value, field, maxLength);
  if (parsed === null) {
    throw new InvalidRequestError(`${field} is required.`);
  }
  return parsed;
}

function optionalInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = toSafeInteger(value);
  if (parsed === null) {
    throw new InvalidRequestError(`${field} must be an integer.`);
  }
  return parsed;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = optionalInteger(value, field);
  if (parsed === null || parsed <= 0) {
    throw new InvalidRequestError(`${field} must be a positive integer.`);
  }
  return parsed;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = toIsoDate(value);
  if (parsed === null) {
    throw new InvalidRequestError(`${field} must be a valid date.`);
  }
  return parsed;
}

function optionalSessionStatus(
  value: unknown,
  field: string,
): SessionStatus {
  if (value === undefined || value === null || value === "") {
    return "scheduled";
  }
  if (!isSessionStatus(value)) {
    throw new InvalidRequestError(
      `${field} must be one of scheduled, started, completed, aborted.`,
    );
  }
  return value;
}

function optionalQualifyingPart(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-3]$/.test(value.trim())
        ? Number(value.trim())
        : null;
  if (parsed === null || !Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
    throw new InvalidRequestError("qualifyingPart must be 1, 2, or 3.");
  }
  return parsed;
}

function optionalQueryString(
  query: Request["query"],
  key: string,
  maxLength: number,
): string | null {
  const raw = query[key];
  if (raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new InvalidRequestError(`${key} must be a single value.`);
  }
  return optionalString(raw, key, maxLength);
}

function optionalQueryInteger(
  query: Request["query"],
  key: string,
): number | null {
  const raw = query[key];
  if (raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new InvalidRequestError(`${key} must be a single value.`);
  }
  const parsed = toSafeInteger(raw);
  if (parsed === null || parsed <= 0) {
    throw new InvalidRequestError(`${key} must be a positive integer.`);
  }
  return parsed;
}

function optionalQueryDate(
  query: Request["query"],
  key: string,
): string | null {
  const raw = query[key];
  if (raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new InvalidRequestError(`${key} must be a single value.`);
  }
  return optionalDate(raw, key);
}

function optionalQueryBoolean(
  query: Request["query"],
  key: string,
): boolean | null {
  const raw = query[key];
  if (raw === undefined) return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new InvalidRequestError(`${key} must be true or false.`);
}

function queryFlag(query: Request["query"], key: string): boolean {
  return optionalQueryBoolean(query, key) ?? false;
}

type ParsedAssociation = {
  sessionKey: number;
  hasQualifyingPart: boolean;
  qualifyingPart: number | null;
  meeting: MeetingInput | null;
  session: SessionInput | null;
};

/**
 * Parses the JSON body accepted by PUT /admin/recordings/:sessionId/association.
 * It mirrors the query metadata of the upload endpoint, but only creates a
 * meeting/session when all the required metadata is present.
 */
function parseAssociationBody(body: unknown): ParsedAssociation {
  const record = asRecord(body);
  if (!record) {
    throw new InvalidRequestError("A JSON object body is required.");
  }

  const sessionKey = positiveInteger(record.sessionKey, "sessionKey");
  const hasQualifyingPart = hasOwn(record, "qualifyingPart");
  const qualifyingPart = hasQualifyingPart
    ? optionalQualifyingPart(record.qualifyingPart)
    : null;

  const metadataFields = [
    "meetingKey",
    "meetingName",
    "officialName",
    "location",
    "countryKey",
    "countryCode",
    "countryName",
    "circuitKey",
    "circuitShortName",
    "year",
    "sessionName",
    "sessionType",
    "startDate",
    "endDate",
    "status",
  ];
  const hasMetadata = metadataFields.some((field) => hasOwn(record, field));

  if (!hasMetadata) {
    return {
      sessionKey,
      hasQualifyingPart,
      qualifyingPart,
      meeting: null,
      session: null,
    };
  }

  const meetingKey = positiveInteger(record.meetingKey, "meetingKey");
  const meetingName = requiredString(record.meetingName, "meetingName", 200);
  const sessionName = requiredString(record.sessionName, "sessionName", 200);
  const sessionType = requiredString(record.sessionType, "sessionType", 100);
  const startDate = optionalDate(record.startDate, "startDate");
  const endDate = optionalDate(record.endDate, "endDate");
  const status = hasOwn(record, "status")
    ? optionalSessionStatus(record.status, "status")
    : "completed";

  const year =
    optionalInteger(record.year, "year") ??
    (startDate
      ? new Date(startDate).getUTCFullYear()
      : new Date().getUTCFullYear());
  if (year < 1900 || year > 2100) {
    throw new InvalidRequestError("year must be between 1900 and 2100.");
  }

  const meeting: MeetingInput = {
    meetingKey,
    name: meetingName,
    officialName: optionalString(record.officialName, "officialName", 300),
    location: optionalString(record.location, "location", 200),
    countryKey: optionalInteger(record.countryKey, "countryKey"),
    countryCode: optionalString(record.countryCode, "countryCode", 10),
    countryName: optionalString(record.countryName, "countryName", 100),
    circuitKey: optionalInteger(record.circuitKey, "circuitKey"),
    circuitShortName: optionalString(
      record.circuitShortName,
      "circuitShortName",
      100,
    ),
    year,
  };

  const session: SessionInput = {
    sessionKey,
    meetingKey,
    name: sessionName,
    type: sessionType,
    startDate,
    endDate,
    status,
  };

  return {
    sessionKey,
    hasQualifyingPart,
    qualifyingPart,
    meeting,
    session,
  };
}

type MeetingPatch = {
  name?: string;
  officialName?: string | null;
  location?: string | null;
  countryKey?: number | null;
  countryCode?: string | null;
  countryName?: string | null;
  circuitKey?: number | null;
  circuitShortName?: string | null;
  year?: number;
};

type SessionPatch = {
  meetingKey?: number | null;
  name?: string;
  type?: string;
  startDate?: string | null;
  endDate?: string | null;
  status?: SessionStatus;
};

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Parses a partial meeting body. Fields that are not present are left
 * undefined so the endpoint can preserve the value already stored in the DB.
 * An explicit null (or empty string) clears an optional field.
 */
function parseMeetingPatch(body: unknown): MeetingPatch {
  const record = asRecord(body);
  if (!record) {
    throw new InvalidRequestError("A JSON object body is required.");
  }

  const patch: MeetingPatch = {};
  if (hasOwn(record, "name")) {
    patch.name = requiredString(record.name, "name", 200);
  }
  if (hasOwn(record, "year")) {
    const year = optionalInteger(record.year, "year");
    if (year === null || year < 1900 || year > 2100) {
      throw new InvalidRequestError(
        "year is required and must be between 1900 and 2100.",
      );
    }
    patch.year = year;
  }
  if (hasOwn(record, "officialName")) {
    patch.officialName = optionalString(
      record.officialName,
      "officialName",
      300,
    );
  }
  if (hasOwn(record, "location")) {
    patch.location = optionalString(record.location, "location", 200);
  }
  if (hasOwn(record, "countryKey")) {
    patch.countryKey = optionalInteger(record.countryKey, "countryKey");
  }
  if (hasOwn(record, "countryCode")) {
    patch.countryCode = optionalString(record.countryCode, "countryCode", 10);
  }
  if (hasOwn(record, "countryName")) {
    patch.countryName = optionalString(record.countryName, "countryName", 100);
  }
  if (hasOwn(record, "circuitKey")) {
    patch.circuitKey = optionalInteger(record.circuitKey, "circuitKey");
  }
  if (hasOwn(record, "circuitShortName")) {
    patch.circuitShortName = optionalString(
      record.circuitShortName,
      "circuitShortName",
      100,
    );
  }
  return patch;
}

/**
 * Parses a partial session body. Fields that are not present are left
 * undefined so the endpoint can preserve the value already stored in the DB.
 * An explicit null (or empty string) clears an optional field.
 */
function parseSessionPatch(body: unknown): SessionPatch {
  const record = asRecord(body);
  if (!record) {
    throw new InvalidRequestError("A JSON object body is required.");
  }

  const patch: SessionPatch = {};
  if (hasOwn(record, "meetingKey")) {
    if (record.meetingKey === null || record.meetingKey === "") {
      patch.meetingKey = null;
    } else {
      patch.meetingKey = positiveInteger(record.meetingKey, "meetingKey");
    }
  }
  if (hasOwn(record, "name")) {
    patch.name = requiredString(record.name, "name", 200);
  }
  if (hasOwn(record, "type")) {
    patch.type = requiredString(record.type, "type", 100);
  }
  if (hasOwn(record, "startDate")) {
    patch.startDate = optionalDate(record.startDate, "startDate");
  }
  if (hasOwn(record, "endDate")) {
    patch.endDate = optionalDate(record.endDate, "endDate");
  }
  if (hasOwn(record, "status")) {
    patch.status = optionalSessionStatus(record.status, "status");
  }
  return patch;
}

function mergeMeetingPatch(
  meetingKey: number,
  patch: MeetingPatch,
  existing: any | null,
): MeetingInput {
  if (!existing) {
    if (patch.name === undefined || patch.year === undefined) {
      throw new InvalidRequestError(
        "name and year are required when creating a meeting.",
      );
    }

    return {
      meetingKey,
      name: patch.name,
      officialName: patch.officialName ?? null,
      location: patch.location ?? null,
      countryKey: patch.countryKey ?? null,
      countryCode: patch.countryCode ?? null,
      countryName: patch.countryName ?? null,
      circuitKey: patch.circuitKey ?? null,
      circuitShortName: patch.circuitShortName ?? null,
      year: patch.year,
    };
  }

  return {
    meetingKey,
    name: patch.name ?? existing.name,
    officialName: hasOwn(patch, "officialName")
      ? patch.officialName ?? null
      : existing.officialName ?? null,
    location: hasOwn(patch, "location")
      ? patch.location ?? null
      : existing.location ?? null,
    countryKey: hasOwn(patch, "countryKey")
      ? patch.countryKey ?? null
      : existing.countryKey ?? null,
    countryCode: hasOwn(patch, "countryCode")
      ? patch.countryCode ?? null
      : existing.countryCode ?? null,
    countryName: hasOwn(patch, "countryName")
      ? patch.countryName ?? null
      : existing.countryName ?? null,
    circuitKey: hasOwn(patch, "circuitKey")
      ? patch.circuitKey ?? null
      : existing.circuitKey ?? null,
    circuitShortName: hasOwn(patch, "circuitShortName")
      ? patch.circuitShortName ?? null
      : existing.circuitShortName ?? null,
    year: patch.year ?? Number(existing.year),
  };
}

function mergeSessionPatch(
  sessionKey: number,
  patch: SessionPatch,
  existing: any | null,
): SessionInput {
  if (!existing) {
    if (
      patch.meetingKey === undefined ||
      patch.meetingKey === null ||
      patch.name === undefined ||
      patch.type === undefined
    ) {
      throw new InvalidRequestError(
        "meetingKey, name and type are required when creating a session.",
      );
    }

    return {
      sessionKey,
      meetingKey: patch.meetingKey,
      name: patch.name,
      type: patch.type,
      startDate: patch.startDate ?? null,
      endDate: patch.endDate ?? null,
      status: patch.status ?? "scheduled",
    };
  }

  return {
    sessionKey,
    meetingKey: hasOwn(patch, "meetingKey")
      ? patch.meetingKey ?? null
      : existing.meetingKey === null || existing.meetingKey === undefined
        ? null
        : Number(existing.meetingKey),
    name: patch.name ?? existing.name,
    type: patch.type ?? existing.type,
    startDate: hasOwn(patch, "startDate")
      ? patch.startDate ?? null
      : toIsoDate(existing.startDate),
    endDate: hasOwn(patch, "endDate")
      ? patch.endDate ?? null
      : toIsoDate(existing.endDate),
    status: patch.status ?? (existing.status as SessionStatus),
  };
}

/**
 * Upload metadata is merged with the stored row so a partial upload cannot
 * erase optional meeting fields the admin already filled in.
 */
function mergeMeetingMetadata(
  existing: any | null,
  incoming: MeetingInput,
): MeetingInput {
  if (!existing) return incoming;

  return {
    meetingKey: incoming.meetingKey,
    name: incoming.name || existing.name,
    officialName: incoming.officialName ?? existing.officialName ?? null,
    location: incoming.location ?? existing.location ?? null,
    countryKey: incoming.countryKey ?? existing.countryKey ?? null,
    countryCode: incoming.countryCode ?? existing.countryCode ?? null,
    countryName: incoming.countryName ?? existing.countryName ?? null,
    circuitKey: incoming.circuitKey ?? existing.circuitKey ?? null,
    circuitShortName:
      incoming.circuitShortName ?? existing.circuitShortName ?? null,
    year: incoming.year ?? Number(existing.year),
  };
}

/**
 * Same as mergeMeetingMetadata, but for session rows. Required identity/name
 * fields are always taken from the upload; optional metadata is preserved when
 * the upload does not provide it.
 */
function mergeSessionMetadata(
  existing: any | null,
  incoming: SessionInput,
): SessionInput {
  if (!existing) return incoming;

  return {
    sessionKey: incoming.sessionKey,
    meetingKey: incoming.meetingKey,
    name: incoming.name || existing.name,
    type: incoming.type || existing.type,
    startDate: incoming.startDate ?? toIsoDate(existing.startDate),
    endDate: incoming.endDate ?? toIsoDate(existing.endDate),
    status: incoming.status,
  };
}

function toMeetingResponse(row: any): any {
  return {
    meetingKey: Number(row.meetingKey),
    name: row.name,
    officialName: row.officialName ?? null,
    location: row.location ?? null,
    country: {
      key: row.countryKey ?? null,
      code: row.countryCode ?? null,
      name: row.countryName ?? null,
    },
    circuit: {
      key: row.circuitKey ?? null,
      shortName: row.circuitShortName ?? null,
    },
    year: Number(row.year),
    sessionCount: Number(row.sessionCount ?? 0),
    recordingCount: Number(row.recordingCount ?? 0),
    firstSessionAt: toIsoDate(row.firstSessionAt),
    lastSessionAt: toIsoDate(row.lastSessionAt),
  };
}

function toSessionResponse(row: any): any {
  return {
    sessionKey: Number(row.sessionKey),
    meetingKey:
      row.meetingKey === null || row.meetingKey === undefined
        ? null
        : Number(row.meetingKey),
    meetingName: row.meetingName ?? null,
    name: row.name,
    type: row.type,
    startDate: toIsoDate(row.startDate),
    endDate: toIsoDate(row.endDate),
    status: row.status,
    recordingCount: Number(row.recordingCount ?? 0),
    hasRecording: Boolean(row.hasRecording),
  };
}

function toFlatRecording(row: any): any {
  return {
    sessionId: row.sessionId,
    filename: row.filename,
    sessionName: row.sessionName ?? null,
    sessionType: row.sessionType ?? null,
    meetingKey: row.meetingKey ?? null,
    sessionKey: row.sessionKey ?? null,
    qualifyingPart: row.qualifyingPart ?? null,
    source: row.source,
    savedAt: toIsoDate(row.savedAt),
    sizeBytes: Number(row.sizeBytes),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

interface RecordingQueryParams {
  sessionKey: number | null;
  meetingKey: number | null;
  meetingName: string | null;
  officialName: string | null;
  location: string | null;
  countryKey: number | null;
  countryCode: string | null;
  countryName: string | null;
  circuitKey: number | null;
  circuitShortName: string | null;
  sessionName: string | null;
  sessionType: string | null;
  startDate: string | null;
  endDate: string | null;
  qualifyingPart: number | null;
}

function parseRecordingQuery(
  query: Request["query"],
): RecordingQueryParams {
  return {
    sessionKey: optionalQueryInteger(query, "sessionKey"),
    meetingKey: optionalQueryInteger(query, "meetingKey"),
    meetingName: optionalQueryString(query, "meetingName", 200),
    officialName: optionalQueryString(query, "officialName", 300),
    location: optionalQueryString(query, "location", 200),
    countryKey: optionalQueryInteger(query, "countryKey"),
    countryCode: optionalQueryString(query, "countryCode", 10),
    countryName: optionalQueryString(query, "countryName", 100),
    circuitKey: optionalQueryInteger(query, "circuitKey"),
    circuitShortName: optionalQueryString(query, "circuitShortName", 100),
    sessionName: optionalQueryString(query, "sessionName", 200),
    sessionType: optionalQueryString(query, "sessionType", 100),
    startDate: optionalQueryDate(query, "startDate"),
    endDate: optionalQueryDate(query, "endDate"),
    qualifyingPart: optionalQualifyingPart(query.qualifyingPart),
  };
}

// Practice sessions always open the race weekend on a Friday, so if the
// next event is 5 days away or less, "now" already falls within that
// weekend's build-up (e.g. the Monday before a Friday FP1).
const WEEK_RACE_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000;

function isWeekRace(timeDiffMs: number): boolean {
  return timeDiffMs <= WEEK_RACE_THRESHOLD_MS;
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

  const unfoldedCalendarData = calendarData
    .replace(/\r?\n[ \t]/g, "")
    .replace(/\r\n/g, "\n");
  const events = ical.parseICS(unfoldedCalendarData);

  const formattedEvents: IcalEvent[] = [];

  for (let eventId in events) {
    const event = events[eventId];
    if (!event.start) continue;

    const start = parseIcalDate(event.start);
    if (!start) {
      // console.log("Unparsed event.start:", eventId, event.start);
      continue;
    }

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
  return formattedEvents;
}

function groupByLocation(formattedEvents: IcalEvent[]) {
  const gruposTemp = new Map<string, EventsByLocation>();

  formattedEvents.forEach((evento) => {
    const { type, track, start, location } = evento;
    const groupKey = `${track || location || "unknown"}|${location || "unknown"}|${start.getUTCFullYear()}`;

    if (!gruposTemp.has(groupKey)) {
      gruposTemp.set(groupKey, { track, start, location });
    }

    const grupo = gruposTemp.get(groupKey)!;

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
  configService: ConfigService,
  emailService: EmailService,
  websocketClient: F1APIWebSocketsClient | null,
  stateProcessor: StateProcessor,
) {
  const router = express.Router();
  const pool = databaseService.getPool();
  const paginationLimit = 50;
  const premiumRoleId = 2;
  const baseRoleId = 1;
  const { requireAuth, requireAdmin, optionalAuth } = createAuthMiddleware(userService);
  let activeProfileSession: inspector.Session | null = null;

  async function calendarHandle(req: Request, res: Response) {
    try {
      const now = new Date();
      const currentYear = now.getUTCFullYear();
      const formattedEvents = (await getEvents()).filter(
        (event) => event.start.getUTCFullYear() === currentYear,
      );

      formattedEvents.sort(
        (a: IcalEvent, b: IcalEvent) => a.start.getTime() - b.start.getTime(),
      );

      const nextEvent =
        formattedEvents.find((e) => e.start.getTime() > now.getTime()) ??
        null;

      const groupsByLocation = groupByLocation(formattedEvents);

      let timeUntilNext = null;
      let weekRace = false;

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

        weekRace = isWeekRace(timeDiff);
      }

      res.json({
        success: true,
        nextEvent,
        timeUntilNext,
        isWeekRace: weekRace,
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

      const nextEvent =
        formattedEvents.find((e) => e.start.getTime() > now.getTime()) ??
        null;

      let timeUntilNext = null;
      let weekRace = false;

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

        weekRace = isWeekRace(timeDiff);
      }

      res.json({
        success: true,
        nextEvent,
        timeUntilNext,
        isWeekRace: weekRace,
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
      {
        name: "Recordings",
        description:
          "F1 session recordings stored in PostgreSQL (authenticated users can list and retrieve; admins can upload, edit, delete, and manage meetings/sessions)",
      },
      {
        name: "Diagnostics",
        description: "Production CPU profiling endpoints (admin only)",
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
      "/config/discord-link": {
        get: {
          tags: ["Settings"],
          summary: "Get the current Discord invite link",
          description:
            "Public endpoint. Backed by Postgres so it survives redeploys; the frontend caches this for 10 days via Next.js data cache.",
          responses: {
            "200": {
              description: "Current Discord invite link",
              content: {
                "application/json": {
                  example: { success: true, url: "https://discord.gg/abc123" },
                },
              },
            },
          },
        },
        put: {
          tags: ["Settings"],
          summary: "Rotate the Discord invite link (admin only)",
          description:
            "Persists the new link to Postgres and best-effort triggers the frontend to revalidate its cached copy immediately.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    url: {
                      type: "string",
                      example: "https://discord.gg/abc123",
                    },
                  },
                  required: ["url"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Updated Discord invite link" },
            "400": { description: "Bad request - invalid invite URL" },
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
      "/users/forgot-password": {
        post: {
          tags: ["Users"],
          summary: "Request a password reset email",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    email: { type: "string", format: "email" },
                  },
                  required: ["email"],
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Always returns success, regardless of whether the email is registered",
            },
            "400": { description: "Bad request" },
          },
        },
      },
      "/users/reset-password": {
        post: {
          tags: ["Users"],
          summary: "Reset password using a token from the forgot-password email",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { type: "string" },
                    password: { type: "string" },
                  },
                  required: ["token", "password"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Password reset" },
            "400": { description: "Invalid/expired token or bad request" },
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
      "/admin/recordings": {
        get: {
          tags: ["Recordings"],
          summary: "List recorded F1 sessions (authenticated users)",
          description:
            "Without `view`, returns the flat list (newest first) with sessionId, sessionName, sessionType, meetingKey, sessionKey, qualifyingPart, source, filename, save date, and byte size. With `view=grouped`, returns meetings -> sessions -> recordings (without the BYTEA content), standalone sessions detached from a meeting, plus an `ungrouped` array; grouped views are filtered to `status = completed` for the replay UI.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "view",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["grouped"],
              },
              description:
                "Use `grouped` to get the meeting/session tree used by the replay list.",
            },
            {
              name: "sessionKey",
              in: "query",
              required: false,
              schema: { type: "integer", example: 11399 },
              description: "Flat list only: filter by session key.",
            },
            {
              name: "meetingKey",
              in: "query",
              required: false,
              schema: { type: "integer", example: 1298 },
              description: "Flat list only: filter by meeting key.",
            },
            {
              name: "unassigned",
              in: "query",
              required: false,
              schema: { type: "boolean" },
              description:
                "Flat list only: true returns recordings without session_key; false returns only associated ones.",
            },
          ],
          responses: {
            "200": {
              description: "Flat recording list or grouped meeting tree.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean", example: true },
                      recordings: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            sessionId: {
                              type: "string",
                              example: "2026-77-race-weekend-race",
                            },
                            filename: {
                              type: "string",
                              example: "2026-77-race-weekend-race.jsonl",
                            },
                            sessionName: {
                              type: "string",
                              nullable: true,
                              example: "Race",
                            },
                            sessionType: {
                              type: "string",
                              nullable: true,
                              example: "Race",
                            },
                            meetingKey: {
                              type: "integer",
                              nullable: true,
                              example: 1298,
                            },
                            sessionKey: {
                              type: "integer",
                              nullable: true,
                              example: 11399,
                            },
                            qualifyingPart: {
                              type: "integer",
                              nullable: true,
                              example: 1,
                            },
                            source: {
                              type: "string",
                              enum: ["manual", "recorder"],
                              example: "manual",
                            },
                            savedAt: {
                              type: "string",
                              format: "date-time",
                            },
                            sizeBytes: { type: "integer", example: 9158656 },
                          },
                        },
                      },
                      meetings: {
                        type: "array",
                        description:
                          "Only present with view=grouped. Meetings with nested sessions and recordings.",
                        items: { type: "object" },
                      },
                      standaloneSessions: {
                        type: "array",
                        description:
                          "Only present with view=grouped. Sessions detached from a meeting (meetingKey null).",
                        items: { type: "object" },
                      },
                      ungrouped: {
                        type: "array",
                        description:
                          "Only present with view=grouped. Recordings without a session_key.",
                        items: { type: "object" },
                      },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid view value" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/admin/recordings/{sessionId}": {
        put: {
          tags: ["Recordings"],
          summary: "Upload a recorded F1 session to PostgreSQL (admin only)",
          description:
            "Upload the JSONL file as the request body. The API associates it automatically by reading R.SessionInfo from the first record. Alternatively, send sessionKey (and optional metadata) to attach it to an existing session, or the full meeting/session metadata to create/update both. Example: /admin/recordings/14032026?sessionKey=11399&qualifyingPart=1",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "sessionId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,234}$",
              },
            },
            {
              name: "sessionKey",
              in: "query",
              required: false,
              schema: {
                type: "integer",
                example: 11399,
              },
              description:
                "SessionInfo.Key. When present, the recording is associated with that session.",
            },
            {
              name: "meetingKey",
              in: "query",
              required: false,
              schema: {
                type: "integer",
                example: 1298,
              },
              description:
                "Meeting.Key. Required only when sending full metadata to create/update a session.",
            },
            {
              name: "qualifyingPart",
              in: "query",
              required: false,
              schema: {
                type: "integer",
                enum: [1, 2, 3],
                example: 1,
              },
              description:
                "Qualifying part (1, 2, or 3) for Q1/Q2/Q3 recordings.",
            },
            {
              name: "sessionName",
              in: "query",
              required: false,
              schema: {
                type: "string",
                maxLength: 200,
                example: "Race",
              },
              description:
                "SessionInfo.Name (for example Race, Sprint, or Qualifying).",
            },
            {
              name: "sessionType",
              in: "query",
              required: false,
              schema: {
                type: "string",
                maxLength: 100,
                example: "Race",
              },
              description:
                "SessionInfo.Type (for example Race or Practice).",
            },
            {
              name: "startDate",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
            },
            {
              name: "endDate",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
            },
            {
              name: "meetingName",
              in: "query",
              required: false,
              schema: { type: "string", maxLength: 200 },
            },
            {
              name: "officialName",
              in: "query",
              required: false,
              schema: { type: "string", maxLength: 300 },
            },
            {
              name: "location",
              in: "query",
              required: false,
              schema: { type: "string", maxLength: 200 },
            },
            {
              name: "countryKey",
              in: "query",
              required: false,
              schema: { type: "integer" },
            },
            {
              name: "countryCode",
              in: "query",
              required: false,
              schema: { type: "string", maxLength: 10 },
            },
            {
              name: "countryName",
              in: "query",
              required: false,
              schema: { type: "string", maxLength: 100 },
            },
            {
              name: "circuitKey",
              in: "query",
              required: false,
              schema: { type: "integer" },
            },
            {
              name: "circuitShortName",
              in: "query",
              required: false,
              schema: { type: "string", maxLength: 100 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/x-ndjson": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          responses: {
            "201": { description: "Recording saved in PostgreSQL; retrying the same session ID updates that recording" },
            "400": { description: "Invalid session ID, metadata, or empty recording" },
            "401": { description: "Unauthorized" },
            "403": { description: "Admin role required" },
            "409": { description: "Another recording already uses this session/qualifyingPart" },
            "413": { description: "Recording exceeds 50 MB" },
          },
        },
        patch: {
          tags: ["Recordings"],
          summary: "Edit a recording by sessionId (admin only)",
          description:
            "Partial update of an already-uploaded recording without sending the JSONL body again. Omitted fields keep their current value. Use this endpoint for ungrouped recordings too: sessionName/sessionType can be fixed without a sessionKey. Send `sessionKey: null` to detach the recording from its session, or a sessionKey to associate it. `qualifyingPart: null` clears the part.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "sessionId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,234}$",
              },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sessionKey: {
                      type: "integer",
                      nullable: true,
                      example: 11399,
                      description:
                        "Session to associate. Omit it to keep the current session; send null to detach.",
                    },
                    meetingKey: {
                      type: "integer",
                      nullable: true,
                      example: 1298,
                      description:
                        "Optional consistency check. When sessionKey is set it must match the session's meeting. When the recording is detached, only null is accepted.",
                    },
                    qualifyingPart: {
                      type: "integer",
                      nullable: true,
                      enum: [1, 2, 3],
                      example: 1,
                      description:
                        "Qualifying part. Omit it to keep the current value; send null to clear it.",
                    },
                    sessionName: {
                      type: "string",
                      nullable: true,
                      example: "Practice 3",
                      description:
                        "Recording label. Useful for ungrouped recordings. Send null to clear it.",
                    },
                    sessionType: {
                      type: "string",
                      nullable: true,
                      example: "Practice",
                      description:
                        "Recording type label. Useful for ungrouped recordings. Send null to clear it.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Recording updated. The response includes previous and the shaped recording.",
            },
            "400": { description: "Invalid session ID or body" },
            "401": { description: "Unauthorized" },
            "403": { description: "Admin role required" },
            "404": { description: "Session or recording not found" },
            "409": { description: "Another recording already uses this session/part" },
          },
        },
        get: {
          tags: ["Recordings"],
          summary: "Retrieve a recorded F1 session by session ID (authenticated users)",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "sessionId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,234}$",
                description: "sessionId returned by GET /admin/recordings (filename without .jsonl).",
              },
            },
          ],
          responses: {
            "200": {
              description: "JSON Lines recording",
              content: {
                "application/x-ndjson": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "404": { description: "Recording not found" },
          },
        },
        delete: {
          tags: ["Recordings"],
          summary: "Delete a recording by sessionId (admin only)",
          description:
            "Deletes only the JSONL row. The meeting and session are kept. This operation is irreversible: use PATCH sessionKey=null to detach instead of deleting.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "sessionId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,234}$",
              },
            },
          ],
          responses: {
            "200": { description: "Recording deleted; previous metadata returned" },
            "400": { description: "Invalid session ID" },
            "401": { description: "Unauthorized" },
            "403": { description: "Admin role required" },
            "404": { description: "Recording not found" },
          },
        },
      },
      "/admin/recordings/{sessionId}/metadata": {
        get: {
          tags: ["Recordings"],
          summary: "Get recording metadata by sessionId (authenticated users)",
          description:
            "Returns the flat recording metadata without downloading the JSONL. Use this to inspect an ungrouped recording before editing it.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "sessionId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,234}$",
              },
            },
          ],
          responses: {
            "200": { description: "Recording metadata" },
            "400": { description: "Invalid session ID" },
            "401": { description: "Unauthorized" },
            "404": { description: "Recording not found" },
          },
        },
      },
      "/admin/recordings/{sessionId}/association": {
        put: {
          tags: ["Recordings"],
          summary:
            "Create/associate a meeting and session for a recording by sessionId (admin only)",
          description:
            "Idempotent PUT. Use { sessionKey } to associate the recording with an existing session, or send full meeting/session metadata to upsert both and associate. With `?fromSessionInfo=true` and an empty body, the API reads R.SessionInfo from the first 16 MB of the stored JSONL and rebuilds the association automatically. This is the recommended way to group old ungrouped recordings without knowing a sessionKey beforehand.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "sessionId",
              in: "path",
              required: true,
              schema: {
                type: "string",
                pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,234}$",
              },
            },
            {
              name: "fromSessionInfo",
              in: "query",
              required: false,
              schema: { type: "boolean", example: true },
              description:
                "Read R.SessionInfo from the stored JSONL instead of requiring a body.",
            },
          ],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sessionKey: { type: "integer", example: 11399 },
                    qualifyingPart: {
                      type: "integer",
                      nullable: true,
                      enum: [1, 2, 3],
                      example: 1,
                    },
                    meetingKey: { type: "integer", example: 1298 },
                    meetingName: {
                      type: "string",
                      example: "Mexico City Grand Prix",
                    },
                    officialName: { type: "string", nullable: true },
                    location: { type: "string", nullable: true },
                    countryKey: { type: "integer", nullable: true },
                    countryCode: { type: "string", nullable: true },
                    countryName: { type: "string", nullable: true },
                    circuitKey: { type: "integer", nullable: true },
                    circuitShortName: { type: "string", nullable: true },
                    year: { type: "integer", example: 2026 },
                    sessionName: { type: "string", example: "Practice 3" },
                    sessionType: { type: "string", example: "Practice" },
                    startDate: {
                      type: "string",
                      format: "date-time",
                      nullable: true,
                    },
                    endDate: {
                      type: "string",
                      format: "date-time",
                      nullable: true,
                    },
                    status: {
                      type: "string",
                      enum: ["scheduled", "started", "completed", "aborted"],
                      example: "completed",
                    },
                  },
                  example: {
                    sessionKey: 11399,
                    qualifyingPart: 1,
                    meetingKey: 1298,
                    meetingName: "Mexico City Grand Prix",
                    year: 2026,
                    sessionName: "Practice 3",
                    sessionType: "Practice",
                    status: "completed",
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Recording associated; response includes recording, session, meeting and previous.",
            },
            "400": { description: "Invalid session ID or association body" },
            "401": { description: "Unauthorized" },
            "403": { description: "Admin role required" },
            "404": { description: "Recording or session not found" },
            "409": { description: "Another recording already uses this session/part" },
          },
        },
      },
      "/admin/meetings": {
        get: {
          tags: ["Recordings"],
          summary: "List meetings (Grand Prix weekends) for replay association",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "year",
              in: "query",
              required: false,
              schema: { type: "integer", example: 2026 },
            },
          ],
          responses: {
            "200": { description: "Meetings with session and recording counts" },
            "400": { description: "Invalid year" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/admin/meetings/{meetingKey}": {
        get: {
          tags: ["Recordings"],
          summary: "Get a meeting with its sessions and recordings",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "meetingKey",
              in: "path",
              required: true,
              schema: { type: "integer", example: 1298 },
            },
          ],
          responses: {
            "200": { description: "Meeting with nested sessions and recordings" },
            "401": { description: "Unauthorized" },
            "404": { description: "Meeting not found" },
          },
        },
        put: {
          tags: ["Recordings"],
          summary: "Create or update a meeting (admin only)",
          description:
            "Partial update: only the fields present in the body are written. Omitted fields keep their current value, so you can fix one field without erasing the rest. `name` and `year` are required only when creating a new meeting. Send `null` to clear an optional field.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "meetingKey",
              in: "path",
              required: true,
              schema: { type: "integer", example: 1298 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: {
                      type: "string",
                      example: "Mexico City Grand Prix",
                    },
                    officialName: { type: "string", nullable: true },
                    location: { type: "string", nullable: true },
                    countryKey: {
                      type: "integer",
                      nullable: true,
                      example: 8,
                    },
                    countryCode: {
                      type: "string",
                      nullable: true,
                      example: "MEX",
                    },
                    countryName: {
                      type: "string",
                      nullable: true,
                      example: "Mexico",
                    },
                    circuitKey: {
                      type: "integer",
                      nullable: true,
                      example: 65,
                    },
                    circuitShortName: {
                      type: "string",
                      nullable: true,
                      example: "Mexico City",
                    },
                    year: { type: "integer", example: 2026 },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Meeting saved" },
            "400": { description: "Invalid meeting payload" },
            "401": { description: "Unauthorized" },
            "403": { description: "Admin role required" },
          },
        },
        delete: {
          tags: ["Recordings"],
          summary: "Delete a meeting (admin only)",
          description:
            "By default (`cascade=false`) the meeting is removed but its sessions are detached (`meetingKey: null`) and its recordings are kept. Use `cascade=true` to delete the meeting, its sessions and their recordings. `dryRun=true` returns the impact without deleting.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "meetingKey",
              in: "path",
              required: true,
              schema: { type: "integer", example: 1298 },
            },
            {
              name: "cascade",
              in: "query",
              required: false,
              schema: { type: "boolean", default: false },
              description:
                "true deletes sessions and recordings; false (default) detaches them.",
            },
            {
              name: "dryRun",
              in: "query",
              required: false,
              schema: { type: "boolean", default: false },
              description: "Preview the affected counts without deleting.",
            },
          ],
          responses: {
            "200": {
              description:
                "Meeting deleted or detached; response includes affected counts and previous snapshot.",
            },
            "400": { description: "Invalid meeting key or query flags" },
            "401": { description: "Unauthorized" },
            "403": { description: "Admin role required" },
            "404": { description: "Meeting not found" },
          },
        },
      },
      "/admin/sessions": {
        get: {
          tags: ["Recordings"],
          summary: "List sessions for replay association",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "meetingKey",
              in: "query",
              required: false,
              schema: { type: "integer", example: 1298 },
            },
            {
              name: "year",
              in: "query",
              required: false,
              schema: { type: "integer", example: 2026 },
            },
            {
              name: "status",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["scheduled", "started", "completed", "aborted"],
              },
            },
            {
              name: "unassigned",
              in: "query",
              required: false,
              schema: { type: "boolean" },
              description:
                "true returns only sessions without meeting (standalone); false only sessions with meeting.",
            },
          ],
          responses: {
            "200": {
              description: "Sessions with recordingCount and hasRecording",
            },
            "400": { description: "Invalid filters" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/admin/sessions/{sessionKey}": {
        get: {
          tags: ["Recordings"],
          summary: "Get a session with its recordings metadata",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "sessionKey",
              in: "path",
              required: true,
              schema: { type: "integer", example: 11399 },
            },
          ],
          responses: {
            "200": { description: "Session with recordings (no content)" },
            "401": { description: "Unauthorized" },
            "404": { description: "Session not found" },
          },
        },
        put: {
          tags: ["Recordings"],
          summary: "Create or update a session (admin only)",
          description:
            "Partial update: only the fields present in the body are written. Omitted fields keep their current value, so you can fix one field without erasing the rest. `meetingKey`, `name` and `type` are required only when creating a new session. Send `meetingKey: null` to detach the session from its meeting. Send `null` in any other optional field to clear it.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "sessionKey",
              in: "path",
              required: true,
              schema: { type: "integer", example: 11399 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    meetingKey: {
                      type: "integer",
                      nullable: true,
                      example: 1298,
                      description:
                        "Meeting to attach this session to. Send null to leave it standalone.",
                    },
                    name: { type: "string", example: "Practice 3" },
                    type: { type: "string", example: "Practice" },
                    startDate: {
                      type: "string",
                      format: "date-time",
                      nullable: true,
                    },
                    endDate: {
                      type: "string",
                      format: "date-time",
                      nullable: true,
                    },
                    status: {
                      type: "string",
                      enum: ["scheduled", "started", "completed", "aborted"],
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Session saved. Response includes previous and the current session.",
            },
            "400": {
              description: "Invalid session payload or meetingKey missing",
            },
            "401": { description: "Unauthorized" },
            "403": { description: "Admin role required" },
          },
        },
        delete: {
          tags: ["Recordings"],
          summary: "Delete a session (admin only)",
          description:
            "By default (`cascade=false`) the session is removed and its recordings are detached (sessionKey/meetingKey null, labels preserved). Use `cascade=true` to delete the recordings too. `dryRun=true` returns the impact without deleting.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "sessionKey",
              in: "path",
              required: true,
              schema: { type: "integer", example: 11399 },
            },
            {
              name: "cascade",
              in: "query",
              required: false,
              schema: { type: "boolean", default: false },
              description:
                "true deletes the recordings; false (default) detaches them.",
            },
            {
              name: "dryRun",
              in: "query",
              required: false,
              schema: { type: "boolean", default: false },
              description: "Preview the affected recording count.",
            },
          ],
          responses: {
            "200": {
              description:
                "Session deleted; response includes affected recordings and previous snapshot.",
            },
            "400": { description: "Invalid session key or query flags" },
            "401": { description: "Unauthorized" },
            "403": { description: "Admin role required" },
            "404": { description: "Session not found" },
          },
        },
      },
      "/admin/profile/start": {
        post: {
          tags: ["Diagnostics"],
          summary: "Start a V8 CPU profiling session (admin only)",
          description:
            "Starts the in-process V8 CPU profiler via the Node inspector module. Meant to be started/stopped around a short, bounded window during real production load (e.g. 30-60s), not left running.",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "Profiling started" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden - admin role required" },
            "409": { description: "A profiling session is already running" },
            "500": { description: "Failed to start the profiler" },
          },
        },
      },
      "/admin/profile/stop": {
        post: {
          tags: ["Diagnostics"],
          summary: "Stop the running CPU profiling session and save it (admin only)",
          description:
            "Stops the profiler started via /admin/profile/start and writes the resulting .cpuprofile file to the server's temp directory. Download it (e.g. via scp) and open it at speedscope.app or in Chrome DevTools.",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Profile saved",
              content: {
                "application/json": {
                  example: {
                    success: true,
                    path: "/tmp/profile-1737158400000.cpuprofile",
                  },
                },
              },
            },
            "400": { description: "No profiling session is running" },
            "401": { description: "Unauthorized" },
            "403": { description: "Forbidden - admin role required" },
            "500": { description: "Failed to stop the profiler" },
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

  router.get("/admin/meetings", requireAuth, async (req, res) => {
    try {
      const year = optionalQueryInteger(req.query, "year");
      const meetings = await databaseService.listMeetings({ year });
      res.json({
        success: true,
        meetings: meetings.map(toMeetingResponse),
      });
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      console.error("[Meetings] Failed to list meetings:", error);
      res.status(500).json({ success: false, error: "Could not list meetings." });
    }
  });

  router.get("/admin/meetings/:meetingKey", requireAuth, async (req, res) => {
    const meetingKey = toSafeInteger(req.params.meetingKey);
    if (meetingKey === null || meetingKey <= 0) {
      res.status(400).json({ success: false, error: "Invalid meeting key." });
      return;
    }

    try {
      const meeting = await databaseService.getMeetingDetails(meetingKey);
      if (!meeting) {
        res.status(404).json({ success: false, error: "Meeting not found." });
        return;
      }
      res.json({ success: true, meeting });
    } catch (error) {
      console.error(`[Meetings] Failed to get ${meetingKey}:`, error);
      res.status(500).json({ success: false, error: "Could not get meeting." });
    }
  });

  router.put("/admin/meetings/:meetingKey", requireAdmin, async (req, res) => {
    const meetingKey = toSafeInteger(req.params.meetingKey);
    if (meetingKey === null || meetingKey <= 0) {
      res.status(400).json({ success: false, error: "Invalid meeting key." });
      return;
    }

    try {
      const patch = parseMeetingPatch(req.body);
      const existing = await databaseService.getMeeting(meetingKey);
      const meeting = mergeMeetingPatch(meetingKey, patch, existing);
      await databaseService.upsertMeeting(meeting);
      const saved = await databaseService.getMeeting(meetingKey);
      if (!saved) throw new Error("Meeting was not persisted.");
      res.json({
        success: true,
        previous: existing ? toMeetingResponse(existing) : null,
        meeting: toMeetingResponse(saved),
      });
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      console.error(`[Meetings] Failed to save ${meetingKey}:`, error);
      res.status(500).json({ success: false, error: "Could not save meeting." });
    }
  });

  router.delete(
    "/admin/meetings/:meetingKey",
    requireAdmin,
    async (req, res) => {
      const meetingKey = toSafeInteger(req.params.meetingKey);
      if (meetingKey === null || meetingKey <= 0) {
        res.status(400).json({ success: false, error: "Invalid meeting key." });
        return;
      }

      try {
        const cascade = queryFlag(req.query, "cascade");
        const dryRun = queryFlag(req.query, "dryRun");
        const existing = await databaseService.getMeeting(meetingKey);
        if (!existing) {
          res.status(404).json({ success: false, error: "Meeting not found." });
          return;
        }

        if (dryRun) {
          res.json({
            success: true,
            deleted: false,
            mode: cascade ? "cascade" : "detach",
            wouldAffect: {
              sessions: Number(existing.sessionCount ?? 0),
              recordings: Number(existing.recordingCount ?? 0),
            },
            previous: toMeetingResponse(existing),
          });
          return;
        }

        const result = await databaseService.deleteMeeting(meetingKey, {
          cascade,
        });
        if (result.status === "not-found") {
          res.status(404).json({ success: false, error: "Meeting not found." });
          return;
        }

        const affectedRecordings = result.recordings?.length ?? 0;
        res.json({
          success: true,
          deleted: true,
          mode: cascade ? "cascade" : "detach",
          affected: {
            sessions: result.sessions?.length ?? 0,
            recordings: affectedRecordings,
          },
          detachedSessions: cascade
            ? []
            : (result.sessions ?? []).map((row: any) => ({
                ...toSessionResponse(row),
                meetingKey: null,
                meetingName: null,
              })),
          deletedRecordings: cascade
            ? (result.recordings ?? []).map(toFlatRecording)
            : [],
          previous: {
            meeting: toMeetingResponse(result.meeting),
            sessions: (result.sessions ?? []).map(toSessionResponse),
          },
        });
      } catch (error) {
        if (error instanceof InvalidRequestError) {
          res.status(400).json({ success: false, error: error.message });
          return;
        }
        console.error(`[Meetings] Failed to delete ${meetingKey}:`, error);
        res
          .status(500)
          .json({ success: false, error: "Could not delete meeting." });
      }
    },
  );

  router.get("/admin/sessions", requireAuth, async (req, res) => {
    try {
      const meetingKey = optionalQueryInteger(req.query, "meetingKey");
      const year = optionalQueryInteger(req.query, "year");
      const unassigned = optionalQueryBoolean(req.query, "unassigned");
      if (meetingKey !== null && unassigned === true) {
        throw new InvalidRequestError(
          "meetingKey cannot be combined with unassigned=true.",
        );
      }
      const statusRaw = req.query.status;
      let status: SessionStatus | null = null;
      if (statusRaw !== undefined) {
        if (typeof statusRaw !== "string" || !isSessionStatus(statusRaw)) {
          throw new InvalidRequestError(
            "status must be one of scheduled, started, completed, aborted.",
          );
        }
        status = statusRaw;
      }

      const sessions = await databaseService.listSessions({
        meetingKey,
        year,
        status,
        unassigned,
      });
      res.json({
        success: true,
        sessions: sessions.map(toSessionResponse),
      });
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      console.error("[Sessions] Failed to list sessions:", error);
      res.status(500).json({ success: false, error: "Could not list sessions." });
    }
  });

  router.get("/admin/sessions/:sessionKey", requireAuth, async (req, res) => {
    const sessionKey = toSafeInteger(req.params.sessionKey);
    if (sessionKey === null || sessionKey <= 0) {
      res.status(400).json({ success: false, error: "Invalid session key." });
      return;
    }

    try {
      const details = await databaseService.getSessionDetails(sessionKey);
      if (!details) {
        res.status(404).json({ success: false, error: "Session not found." });
        return;
      }
      res.json({
        success: true,
        session: {
          ...toSessionResponse(details.session),
          recordings: details.recordings,
        },
      });
    } catch (error) {
      console.error(`[Sessions] Failed to get ${sessionKey}:`, error);
      res.status(500).json({ success: false, error: "Could not get session." });
    }
  });

  router.put("/admin/sessions/:sessionKey", requireAdmin, async (req, res) => {
    const sessionKey = toSafeInteger(req.params.sessionKey);
    if (sessionKey === null || sessionKey <= 0) {
      res.status(400).json({ success: false, error: "Invalid session key." });
      return;
    }

    try {
      const patch = parseSessionPatch(req.body);
      const existing = await databaseService.getSession(sessionKey);
      const session = mergeSessionPatch(sessionKey, patch, existing);
      if (session.meetingKey !== null) {
        const meeting = await databaseService.getMeeting(session.meetingKey);
        if (!meeting) {
          res.status(400).json({
            success: false,
            error: "meetingKey does not exist.",
          });
          return;
        }
      }

      await databaseService.upsertSession(session);
      const saved = await databaseService.getSession(sessionKey);
      if (!saved) throw new Error("Session was not persisted.");
      res.json({
        success: true,
        previous: existing ? toSessionResponse(existing) : null,
        session: toSessionResponse(saved),
      });
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      console.error(`[Sessions] Failed to save ${sessionKey}:`, error);
      res.status(500).json({ success: false, error: "Could not save session." });
    }
  });

  router.delete(
    "/admin/sessions/:sessionKey",
    requireAdmin,
    async (req, res) => {
      const sessionKey = toSafeInteger(req.params.sessionKey);
      if (sessionKey === null || sessionKey <= 0) {
        res.status(400).json({ success: false, error: "Invalid session key." });
        return;
      }

      try {
        const cascade = queryFlag(req.query, "cascade");
        const dryRun = queryFlag(req.query, "dryRun");
        const existing = await databaseService.getSession(sessionKey);
        if (!existing) {
          res.status(404).json({ success: false, error: "Session not found." });
          return;
        }

        if (dryRun) {
          res.json({
            success: true,
            deleted: false,
            mode: cascade ? "cascade" : "detach",
            wouldAffect: {
              recordings: Number(existing.recordingCount ?? 0),
            },
            previous: toSessionResponse(existing),
          });
          return;
        }

        const result = await databaseService.deleteSession(sessionKey, {
          cascade,
        });
        if (result.status === "not-found") {
          res.status(404).json({ success: false, error: "Session not found." });
          return;
        }

        res.json({
          success: true,
          deleted: true,
          mode: cascade ? "cascade" : "detach",
          affected: {
            recordings: result.recordings?.length ?? 0,
          },
          detachedRecordings: cascade
            ? []
            : (result.recordings ?? []).map((row: any) => ({
                ...toFlatRecording(row),
                sessionKey: null,
                meetingKey: null,
              })),
          deletedRecordings: cascade
            ? (result.recordings ?? []).map(toFlatRecording)
            : [],
          previous: toSessionResponse(result.session),
        });
      } catch (error) {
        if (error instanceof InvalidRequestError) {
          res.status(400).json({ success: false, error: error.message });
          return;
        }
        console.error(`[Sessions] Failed to delete ${sessionKey}:`, error);
        res
          .status(500)
          .json({ success: false, error: "Could not delete session." });
      }
    },
  );

  router.get("/admin/recordings", requireAuth, async (req, res) => {
    const view = req.query.view;
    if (view !== undefined) {
      if (typeof view !== "string" || view !== "grouped") {
        res.status(400).json({
          success: false,
          error: "view must be 'grouped'.",
        });
        return;
      }

      try {
        const grouped = await databaseService.getGroupedRecordings();
        res.json({ success: true, ...grouped });
      } catch (error) {
        console.error("[Recordings] Failed to list grouped recordings:", error);
        res.status(500).json({
          success: false,
          error: "Could not list grouped recordings.",
        });
      }
      return;
    }

    try {
      const sessionKey = optionalQueryInteger(req.query, "sessionKey");
      const meetingKey = optionalQueryInteger(req.query, "meetingKey");
      const unassigned = optionalQueryBoolean(req.query, "unassigned");
      if (sessionKey !== null && unassigned === true) {
        throw new InvalidRequestError(
          "sessionKey cannot be combined with unassigned=true.",
        );
      }

      const conditions: string[] = [];
      const values: any[] = [];
      if (sessionKey !== null) {
        values.push(sessionKey);
        conditions.push(`session_key = $${values.length}`);
      }
      if (meetingKey !== null) {
        values.push(meetingKey);
        conditions.push(`meeting_key = $${values.length}`);
      }
      if (unassigned !== null) {
        conditions.push(
          unassigned ? "session_key IS NULL" : "session_key IS NOT NULL",
        );
      }

      const result = await pool.query(
        `SELECT
          session_id AS "sessionId",
          filename,
          session_name AS "sessionName",
          session_type AS "sessionType",
          meeting_key AS "meetingKey",
          session_key AS "sessionKey",
          qualifying_part AS "qualifyingPart",
          source,
          saved_at AS "savedAt",
          octet_length(content) AS "sizeBytes"
        FROM session_recordings
        ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY saved_at DESC, session_id ASC`,
        values,
      );
      const recordings = result.rows.map(toFlatRecording);
      res.json({ success: true, recordings });
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      console.error("[Recordings] Failed to list recordings:", error);
      res.status(500).json({ success: false, error: "Could not list recordings." });
    }
  });

  router.put(
    "/admin/recordings/:sessionId",
    requireAdmin,
    express.raw({ type: "application/x-ndjson", limit: MAX_RECORDING_BYTES }),
    async (req, res) => {
      const sessionId = req.params.sessionId;
      if (
        typeof sessionId !== "string" ||
        !RECORDING_SESSION_ID_PATTERN.test(sessionId)
      ) {
        res.status(400).json({ success: false, error: "Invalid recording session ID." });
        return;
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ success: false, error: "Recording body is required." });
        return;
      }

      let params: RecordingQueryParams;
      try {
        params = parseRecordingQuery(req.query);
      } catch (error) {
        if (error instanceof InvalidRequestError) {
          res.status(400).json({ success: false, error: error.message });
          return;
        }
        throw error;
      }

      let resolved: {
        meetingKey: number | null;
        sessionKey: number;
        sessionName: string;
        sessionType: string;
      } | null = null;

      try {
        if (
          params.sessionKey !== null &&
          params.meetingKey !== null &&
          params.meetingName !== null &&
          params.sessionName !== null &&
          params.sessionType !== null
        ) {
          const existingMeeting = await databaseService.getMeeting(
            params.meetingKey,
          );
          const existingSession = await databaseService.getSession(
            params.sessionKey,
          );
          const year = params.startDate
            ? new Date(params.startDate).getUTCFullYear()
            : existingMeeting
              ? Number(existingMeeting.year)
              : new Date().getUTCFullYear();
          const meeting = mergeMeetingMetadata(existingMeeting, {
            meetingKey: params.meetingKey,
            name: params.meetingName,
            officialName: params.officialName,
            location: params.location,
            countryKey: params.countryKey,
            countryCode: params.countryCode,
            countryName: params.countryName,
            circuitKey: params.circuitKey,
            circuitShortName: params.circuitShortName,
            year,
          });
          const session = mergeSessionMetadata(existingSession, {
            sessionKey: params.sessionKey,
            meetingKey: params.meetingKey,
            name: params.sessionName,
            type: params.sessionType,
            startDate: params.startDate,
            endDate: params.endDate,
            status: "completed",
          });

          await databaseService.upsertMeeting(meeting);
          await databaseService.upsertSession(session);
          resolved = {
            meetingKey: meeting.meetingKey,
            sessionKey: session.sessionKey,
            sessionName: session.name,
            sessionType: session.type,
          };
        } else if (params.sessionKey !== null) {
          const session = await databaseService.getSession(params.sessionKey);
          if (!session) {
            res.status(404).json({
              success: false,
              error:
                "Session not found. Create it with PUT /admin/sessions/:sessionKey or send full session metadata.",
            });
            return;
          }
          resolved = {
            meetingKey:
              session.meetingKey === null || session.meetingKey === undefined
                ? null
                : Number(session.meetingKey),
            sessionKey: Number(session.sessionKey),
            sessionName: session.name,
            sessionType: session.type,
          };
        } else {
          const info = extractSessionInfoFromRecording(req.body);
          if (!info) {
            res.status(400).json({
              success: false,
              error:
                "Could not determine the session. Send sessionKey or a JSONL file containing R.SessionInfo.",
            });
            return;
          }

          const existingMeeting = await databaseService.getMeeting(
            info.meeting.meetingKey,
          );
          const existingSession = await databaseService.getSession(
            info.session.sessionKey,
          );
          const meeting = mergeMeetingMetadata(existingMeeting, {
            ...info.meeting,
            year:
              info.session.startDate === null && existingMeeting
                ? Number(existingMeeting.year)
                : info.meeting.year,
          });
          const session = mergeSessionMetadata(existingSession, info.session);
          await databaseService.upsertMeeting(meeting);
          await databaseService.upsertSession(session);
          resolved = {
            meetingKey: meeting.meetingKey,
            sessionKey: session.sessionKey,
            sessionName: session.name,
            sessionType: session.type,
          };
        }

        if (!resolved) {
          res.status(500).json({
            success: false,
            error: "Could not resolve the recording session.",
          });
          return;
        }

        try {
          const recording = await databaseService.saveRecording({
            sessionId,
            filename: `${sessionId}.jsonl`,
            content: req.body,
            sessionName: params.sessionName ?? resolved.sessionName,
            sessionType: params.sessionType ?? resolved.sessionType,
            meetingKey: resolved.meetingKey,
            sessionKey: resolved.sessionKey,
            qualifyingPart: params.qualifyingPart,
            source: "manual",
          });

          res.status(201).json({ success: true, ...toFlatRecording(recording) });
        } catch (error) {
          if (isUniqueViolation(error)) {
            const existingSessionId =
              await databaseService.findRecordingIdBySessionPart(
                resolved.sessionKey,
                params.qualifyingPart,
              );
            res.status(409).json({
              success: false,
              error:
                "A recording already exists for this session and qualifying part.",
              existingSessionId,
            });
            return;
          }
          throw error;
        }
      } catch (error) {
        console.error(`[Recordings] Failed to save ${sessionId} in PostgreSQL:`, error);
        res.status(500).json({
          success: false,
          error: "Could not save recording in PostgreSQL.",
        });
      }
    },
  );

  router.patch("/admin/recordings/:sessionId", requireAdmin, async (req, res) => {
    const sessionId = req.params.sessionId;
    if (
      typeof sessionId !== "string" ||
      !RECORDING_SESSION_ID_PATTERN.test(sessionId)
    ) {
      res.status(400).json({ success: false, error: "Invalid recording session ID." });
      return;
    }

    let hasSessionKey = false;
    let hasQualifyingPart = false;
    let hasSessionName = false;
    let hasSessionType = false;
    let hasMeetingKey = false;
    let requestedSessionKey: number | null = null;
    let requestedQualifyingPart: number | null = null;
    let requestedSessionName: string | null = null;
    let requestedSessionType: string | null = null;
    let requestedMeetingKey: number | null = null;

    try {
      const body = asRecord(req.body);
      if (!body) {
        throw new InvalidRequestError("A JSON object body is required.");
      }
      hasSessionKey = hasOwn(body, "sessionKey");
      hasQualifyingPart = hasOwn(body, "qualifyingPart");
      hasSessionName = hasOwn(body, "sessionName");
      hasSessionType = hasOwn(body, "sessionType");
      hasMeetingKey = hasOwn(body, "meetingKey");
      if (
        !hasSessionKey &&
        !hasQualifyingPart &&
        !hasSessionName &&
        !hasSessionType &&
        !hasMeetingKey
      ) {
        throw new InvalidRequestError(
          "Provide at least one of sessionKey, meetingKey, qualifyingPart, sessionName or sessionType.",
        );
      }
      if (hasSessionKey) {
        requestedSessionKey =
          body.sessionKey === null || body.sessionKey === ""
            ? null
            : positiveInteger(body.sessionKey, "sessionKey");
      }
      if (hasQualifyingPart) {
        requestedQualifyingPart = optionalQualifyingPart(body.qualifyingPart);
      }
      if (hasSessionName) {
        requestedSessionName = optionalString(
          body.sessionName,
          "sessionName",
          200,
        );
      }
      if (hasSessionType) {
        requestedSessionType = optionalString(
          body.sessionType,
          "sessionType",
          100,
        );
      }
      if (hasMeetingKey) {
        requestedMeetingKey =
          body.meetingKey === null || body.meetingKey === ""
            ? null
            : positiveInteger(body.meetingKey, "meetingKey");
      }
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      throw error;
    }

    let finalSessionKey: number | null = null;
    let finalMeetingKey: number | null = null;
    let finalQualifyingPart: number | null = null;

    try {
      const existing = await databaseService.getRecordingMetadata(sessionId);
      if (!existing) {
        res.status(404).json({ success: false, error: "Recording not found." });
        return;
      }

      let session: any | null = null;
      if (hasSessionKey && requestedSessionKey !== null) {
        session = await databaseService.getSession(requestedSessionKey);
        if (!session) {
          res.status(404).json({ success: false, error: "Session not found." });
          return;
        }
      }

      finalSessionKey = hasSessionKey
        ? requestedSessionKey
        : existing.sessionKey === null || existing.sessionKey === undefined
          ? null
          : Number(existing.sessionKey);

      if (hasSessionKey) {
        finalMeetingKey =
          finalSessionKey === null
            ? null
            : session?.meetingKey === null || session?.meetingKey === undefined
              ? null
              : Number(session.meetingKey);
      } else {
        finalMeetingKey =
          existing.meetingKey === null || existing.meetingKey === undefined
            ? null
            : Number(existing.meetingKey);
      }

      if (hasMeetingKey) {
        if (finalSessionKey === null) {
          if (requestedMeetingKey !== null) {
            throw new InvalidRequestError(
              "meetingKey cannot be set while the recording is detached from a session.",
            );
          }
          finalMeetingKey = null;
        } else {
          if (requestedMeetingKey === null) {
            throw new InvalidRequestError(
              "meetingKey must match the session's meeting; it cannot be null while sessionKey is set.",
            );
          }
          const expectedMeetingKey =
            finalMeetingKey === null ? null : Number(finalMeetingKey);
          if (requestedMeetingKey !== expectedMeetingKey) {
            throw new InvalidRequestError(
              "meetingKey must match the meeting of the associated session.",
            );
          }
        }
      }

      finalQualifyingPart = hasQualifyingPart
        ? requestedQualifyingPart
        : existing.qualifyingPart === null ||
            existing.qualifyingPart === undefined
          ? null
          : Number(existing.qualifyingPart);

      const recording = await databaseService.updateRecordingAssociation(
        sessionId,
        {
          sessionKey: finalSessionKey,
          meetingKey: finalMeetingKey,
          sessionName: hasSessionName
            ? requestedSessionName
            : existing.sessionName ?? (session ? session.name : null),
          sessionType: hasSessionType
            ? requestedSessionType
            : existing.sessionType ?? (session ? session.type : null),
          qualifyingPart: finalQualifyingPart,
        },
      );
      if (!recording) {
        res.status(404).json({ success: false, error: "Recording not found." });
        return;
      }

      res.json({
        success: true,
        previous: toFlatRecording(existing),
        recording: toFlatRecording(recording),
        session: session ? toSessionResponse(session) : null,
      });
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      if (isUniqueViolation(error)) {
        const existingSessionId =
          finalSessionKey === null
            ? null
            : await databaseService.findRecordingIdBySessionPart(
                finalSessionKey,
                finalQualifyingPart,
              );
        res.status(409).json({
          success: false,
          error:
            "A recording already exists for this session and qualifying part.",
          existingSessionId,
        });
        return;
      }
      console.error(`[Recordings] Failed to patch ${sessionId}:`, error);
      res.status(500).json({
        success: false,
        error: "Could not update recording.",
      });
    }
  });

  router.get(
    "/admin/recordings/:sessionId/metadata",
    requireAuth,
    async (req, res) => {
      const sessionId = req.params.sessionId;
      if (
        typeof sessionId !== "string" ||
        !RECORDING_SESSION_ID_PATTERN.test(sessionId)
      ) {
        res.status(400).json({
          success: false,
          error: "Invalid recording session ID.",
        });
        return;
      }

      try {
        const recording = await databaseService.getRecordingMetadata(sessionId);
        if (!recording) {
          res
            .status(404)
            .json({ success: false, error: "Recording not found." });
          return;
        }
        res.json({ success: true, recording: toFlatRecording(recording) });
      } catch (error) {
        console.error(`[Recordings] Failed to get ${sessionId}:`, error);
        res.status(500).json({
          success: false,
          error: "Could not get recording metadata.",
        });
      }
    },
  );

  router.put(
    "/admin/recordings/:sessionId/association",
    requireAdmin,
    async (req, res) => {
      const sessionId = req.params.sessionId;
      if (
        typeof sessionId !== "string" ||
        !RECORDING_SESSION_ID_PATTERN.test(sessionId)
      ) {
        res.status(400).json({
          success: false,
          error: "Invalid recording session ID.",
        });
        return;
      }

      let parsed: ParsedAssociation;
      try {
        const fromSessionInfo = queryFlag(req.query, "fromSessionInfo");
        if (fromSessionInfo) {
          const prefix = await databaseService.getRecordingPrefix(
            sessionId,
            SESSION_INFO_SCAN_BYTES,
          );
          if (!prefix) {
            res
              .status(404)
              .json({ success: false, error: "Recording not found." });
            return;
          }
          const info = extractSessionInfoFromRecording(prefix);
          if (!info) {
            res.status(400).json({
              success: false,
              error:
                "The recording does not contain R.SessionInfo in its first records.",
            });
            return;
          }
          const body = asRecord(req.body) ?? {};
          const hasQualifyingPart = hasOwn(body, "qualifyingPart");
          parsed = {
            sessionKey: info.session.sessionKey,
            hasQualifyingPart,
            qualifyingPart: hasQualifyingPart
              ? optionalQualifyingPart(body.qualifyingPart)
              : null,
            meeting: info.meeting,
            session: info.session,
          };
        } else {
          parsed = parseAssociationBody(req.body);
        }
      } catch (error) {
        if (error instanceof InvalidRequestError) {
          res.status(400).json({ success: false, error: error.message });
          return;
        }
        console.error(`[Recordings] Failed to parse ${sessionId}:`, error);
        res.status(500).json({
          success: false,
          error: "Could not parse the association payload.",
        });
        return;
      }

      try {
        const previous = await databaseService.getRecordingMetadata(sessionId);
        if (!previous) {
          res
            .status(404)
            .json({ success: false, error: "Recording not found." });
          return;
        }

        const result = await databaseService.linkRecording(sessionId, parsed);
        if (result.status === "recording-not-found") {
          res
            .status(404)
            .json({ success: false, error: "Recording not found." });
          return;
        }
        if (result.status === "session-not-found") {
          res.status(404).json({
            success: false,
            error:
              "Session not found. Send full meeting and session metadata to create it.",
          });
          return;
        }

        res.json({
          success: true,
          previous: toFlatRecording(previous),
          recording: toFlatRecording(result.recording),
          session: result.session ? toSessionResponse(result.session) : null,
          meeting: result.meeting ? toMeetingResponse(result.meeting) : null,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          const existingSessionId =
            await databaseService.findRecordingIdBySessionPart(
              parsed.sessionKey,
              parsed.qualifyingPart,
            );
          res.status(409).json({
            success: false,
            error:
              "A recording already exists for this session and qualifying part.",
            existingSessionId,
          });
          return;
        }
        console.error(`[Recordings] Failed to associate ${sessionId}:`, error);
        res.status(500).json({
          success: false,
          error: "Could not associate recording.",
        });
      }
    },
  );

  router.delete(
    "/admin/recordings/:sessionId",
    requireAdmin,
    async (req, res) => {
      const sessionId = req.params.sessionId;
      if (
        typeof sessionId !== "string" ||
        !RECORDING_SESSION_ID_PATTERN.test(sessionId)
      ) {
        res.status(400).json({
          success: false,
          error: "Invalid recording session ID.",
        });
        return;
      }

      try {
        const deleted = await databaseService.deleteRecording(sessionId);
        if (!deleted) {
          res
            .status(404)
            .json({ success: false, error: "Recording not found." });
          return;
        }
        res.json({
          success: true,
          deleted: toFlatRecording(deleted),
          previous: toFlatRecording(deleted),
        });
      } catch (error) {
        console.error(`[Recordings] Failed to delete ${sessionId}:`, error);
        res.status(500).json({
          success: false,
          error: "Could not delete recording.",
        });
      }
    },
  );

  router.get("/admin/recordings/:sessionId", requireAuth, async (req, res) => {
    const sessionId = req.params.sessionId;
    if (
      typeof sessionId !== "string" ||
      !RECORDING_SESSION_ID_PATTERN.test(sessionId)
    ) {
      res.status(404).json({ success: false, error: "Recording not found." });
      return;
    }

    try {
      const result = await pool.query(
        `SELECT filename, content
         FROM session_recordings
         WHERE session_id = $1`,
        [sessionId],
      );
      const recording = result.rows[0];
      if (!recording) {
        res.status(404).json({ success: false, error: "Recording not found." });
        return;
      }

      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${recording.filename}"`,
      );
      res.setHeader("Content-Length", recording.content.length);
      res.send(recording.content);
    } catch (error) {
      console.error(`[Recordings] Failed to retrieve ${sessionId} from PostgreSQL:`, error);
      res.status(500).json({
        success: false,
        error: "Could not retrieve recording from PostgreSQL.",
      });
    }
  });

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
  router.get("/settings/full-data-roles", requireAdmin, async (req: Request, res: Response) => {
    try {
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
  router.put("/settings/full-data-roles", requireAdmin, async (req: Request, res: Response) => {
    try {
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

  // GET /config/discord-link - Current Discord invite link (public)
  router.get("/config/discord-link", async (req: Request, res: Response) => {
    try {
      const url = await configService.getDiscordInviteUrl();
      res.json({ success: true, url });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // PUT /config/discord-link - Rotate the Discord invite link (admin only)
  router.put("/config/discord-link", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { url } = req.body;
      if (typeof url !== "string" || !/^https:\/\/discord\.gg\/[\w-]+$/.test(url)) {
        return res.status(400).json({
          success: false,
          error: "url must be a valid https://discord.gg/<code> invite link",
        });
      }

      const updatedUrl = await configService.setDiscordInviteUrl(url);

      // Best-effort: bust the frontend's cached copy immediately instead of
      // waiting for its 10-day revalidation window. If this fails (frontend
      // down, misconfigured secret), the link is still saved and the
      // frontend will pick it up on its next scheduled revalidation.
      if (process.env.FRONTEND_REVALIDATE_URL && process.env.REVALIDATE_SECRET) {
        axios
          .post(process.env.FRONTEND_REVALIDATE_URL, {
            tag: "discord-link",
            secret: process.env.REVALIDATE_SECRET,
          })
          .catch((err) =>
            console.error("Failed to trigger frontend revalidation:", err.message),
          );
      }

      res.json({ success: true, url: updatedUrl });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  });

  router.post("/admin/bridge/reset-reconnect", requireAdmin, async (req: Request, res: Response) => {
    try {
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

  // Starts the V8 CPU profiler in-process (no restart, no exposed --inspect
  // port). Meant to be started/stopped around a short, bounded window
  // during real production load, not left running.
  router.post("/admin/profile/start", requireAdmin, async (req: Request, res: Response) => {
    if (activeProfileSession) {
      return res
        .status(409)
        .json({ success: false, error: "A profiling session is already running." });
    }

    try {
      const session = new inspector.Session();
      session.connect();
      await new Promise<void>((resolve, reject) =>
        session.post("Profiler.enable", (err) => (err ? reject(err) : resolve())),
      );
      await new Promise<void>((resolve, reject) =>
        session.post("Profiler.start", (err) => (err ? reject(err) : resolve())),
      );

      activeProfileSession = session;
      res.json({ success: true, message: "CPU profiling started." });
    } catch (err) {
      activeProfileSession = null;
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.post("/admin/profile/stop", requireAdmin, async (req: Request, res: Response) => {
    if (!activeProfileSession) {
      return res
        .status(400)
        .json({ success: false, error: "No profiling session is running." });
    }

    const session = activeProfileSession;
    activeProfileSession = null;

    try {
      const { profile } = await new Promise<any>((resolve, reject) =>
        session.post("Profiler.stop", (err, params) =>
          err ? reject(err) : resolve(params),
        ),
      );
      session.disconnect();

      const filename = `profile-${Date.now()}.cpuprofile`;
      const filepath = path.join(os.tmpdir(), filename);
      fs.writeFileSync(filepath, JSON.stringify(profile));

      res.json({ success: true, path: filepath });
    } catch (err) {
      session.disconnect();
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

  router.post(
    "/users/forgot-password",
    async (req: Request, res: Response) => {
      const { email } = req.body;
      if (!email) {
        return res
          .status(400)
          .json({ success: false, error: "VALIDATION_REQUIRED" });
      }
      const locale = req.body.locale === "es" ? "es" : "en";

      // Always return a generic success response, whether or not the email
      // is registered or a token was actually issued, so this endpoint
      // can't be used to enumerate registered accounts.
      try {
        const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
        const rawToken = await userService.requestPasswordReset(email, ip);
        if (rawToken) {
          const frontendUrl = process.env.FRONTEND_URL || "https://www.f1telemetry.com";
          const resetUrl = `${frontendUrl}/${locale}/reset-password?token=${rawToken}`;
          await emailService.sendPasswordResetEmail(email, resetUrl, locale);
        }
      } catch (err) {
        console.error("Error in /users/forgot-password:", err);
      }

      res.json({ success: true });
    },
  );

  router.post("/users/reset-password", async (req: Request, res: Response) => {
    try {
      const { token, password } = req.body;
      if (!token || !password) {
        return res
          .status(400)
          .json({ success: false, error: "VALIDATION_REQUIRED" });
      }
      if (password.length < 8) {
        return res
          .status(400)
          .json({ success: false, error: "PASSWORD_TOO_SHORT" });
      }
      await userService.resetPassword(token, password);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  });

  // GET /users - Get all registered users (admin only)
  router.get("/users", requireAdmin, async (req: Request, res: Response) => {
    try {
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
  router.get("/users/base", requireAdmin, async (req: Request, res: Response) => {
    try {
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
  router.get("/users/premium", requireAdmin, async (req: Request, res: Response) => {
    try {
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
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
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
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
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
  router.delete("/users/:id", requireAdmin, async (req: Request, res: Response) => {
    try {
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
  router.post("/users/:id/role", requireAdmin, async (req: Request, res: Response) => {
    try {
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
