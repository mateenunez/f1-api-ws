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

## [Unreleased]

## [2.0.0] - 2026-07-12

### Added

- Role-based authorization for telemetry data endpoints.
- API Endpoint to update discord server.

### Removed

- Chat system: dropped the `chat_pinned_messages` table and the legacy
  `chat_color`/`chat_badge` user columns.
