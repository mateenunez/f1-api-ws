# Changelog

All notable changes to f1-api-ws (backend) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## About the version numbers here

f1-api-ws (this repo) and its frontend, `f1-telemetry`, ship independently and each
keeps its own `package.json` version for its own builds/releases. The versions in
**this file** track the product as a whole from a user's point of view, so they do
not have to match `package.json`'s `version` field, and `f1-telemetry`'s
`CHANGELOG.md` uses this same numbering — a release note here and its frontend
counterpart should usually share a version number and land together.

A curated, translated subset of these entries is shown to users in the frontend at
`/changelog` (see `f1-telemetry/lib/changelog/changelog.ts`). When you make a
user-facing change here, add a matching item there too.

## [2.3.0] - 2026-11-04

### Added

- Meetings and sessions are now persisted in PostgreSQL and exposed through
  `/admin/meetings` and `/admin/sessions`, so replays can be grouped by Grand
  Prix weekend and session.
- `GET /admin/recordings?view=grouped` returns the meeting/session tree used by
  the replay list, plus `ungrouped` recordings and `standaloneSessions`.
- Session metadata is extracted from the uploaded JSONL (`R.SessionInfo`) to
  automatically fill meeting/session details when available.
- `PATCH /admin/recordings/:sessionId` to associate an uploaded recording with a
  session and qualifying part.
- `DELETE /admin/recordings/:sessionId` to remove a stored JSONL.
- `GET /admin/recordings/:sessionId/metadata` to inspect a recording by its
  string `sessionId` without downloading the file.
- `PUT /admin/recordings/:sessionId/association` to create/attach a
  meeting + session from an ungrouped recording, including
  `?fromSessionInfo=true` to rebuild it from the stored JSONL.
- `DELETE /admin/meetings/:meetingKey` with `cascade`/`dryRun` modes.
- `DELETE /admin/sessions/:sessionKey` with `cascade`/`dryRun` modes.
- Filters `sessionKey`, `meetingKey` and `unassigned` for the flat recordings
  list, and `unassigned` for `GET /admin/sessions`.

### Changed

- Sessions can now exist without a meeting (`meeting_key` nullable) and
  `DELETE /admin/meetings/:meetingKey` detaches them by default.
- `PATCH /admin/recordings/:sessionId` now edits `sessionName`, `sessionType`,
  `sessionKey` (including `null` to detach) and `meetingKey`.
- Mutations return a `previous` snapshot to make client-side undo possible.
- `session_recordings.meeting_key` is kept in sync whenever a session moves.
- `session_recordings` now enforces foreign keys to meetings and sessions;
  existing orphan references are cleaned up on startup.

## [2.3.0] - 2026-10-31

### Added

- F1 session recordings are stored in PostgreSQL and exposed through
  authenticated list/download and admin upload endpoints, enabling in-browser
  replay.

### Fixed

- Calendar API now filters events to the current year, groups meetings by
  track/location/year, and unfolds multi-line ICS fields correctly.

## [2.2.0] - 2026-09-05

### Changed

- Increased server capacity to support higher concurrency and keep the platform
  stable during peak usage.

## [2.1.0] - 2026-08-02

### Added

- Forgot/reset password endpoints with email delivery and reset tokens.

### Changed

- Calendar API now returns both past and future events and calculates the next
  upcoming event separately.
- Reduced WebSocket bandwidth by throttling high-frequency telemetry feeds.

## [2.0.0] - 2026-07-12

### Added

- Role-based authorization for telemetry data endpoints.
- API Endpoint to update discord server.

### Removed

- Chat system: dropped the `chat_pinned_messages` table and the legacy
  `chat_color`/`chat_badge` user columns.
