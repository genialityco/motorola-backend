# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run start:dev    # Dev server with hot reload
npm run build        # Compile TypeScript via NestJS CLI → dist/
npm run start:prod   # Run compiled dist directly (node dist/main)
```

No test runner is configured.

## Environment Setup

Copy `.env.example` to `.env`. Two modes:

**Local (emulators):** set `USE_FIREBASE_EMULATORS=true`, then run `firebase emulators:start` before the backend. No service account needed.

**Production:** set `USE_FIREBASE_EMULATORS=false` and point `GOOGLE_APPLICATION_CREDENTIALS` at a `service-account.json`. Also requires `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_VERIFY_TOKEN`.

Emulator ports: Firestore `8010`, Auth `9099`, Storage `9199`.

## Architecture

NestJS app with global `api/` prefix, port 3001. No ORM — all persistence goes directly through Firebase Admin SDK. Five feature modules plus a shared Firebase module.

**`firebase`** — Global singleton (`@Global()`). `FirebaseService` exposes `.db` (Firestore), `.auth` (Auth), `.storage` (Storage). Emulator hosts must be set on `process.env` before `initializeApp()`, which this service handles.

**`auth`** — `FirebaseAuthGuard` reads `Authorization: Bearer <token>`, calls `verifyIdToken()`, and attaches the decoded token to `req.user`. Applied per-controller with `@UseGuards(FirebaseAuthGuard)`.

**`tickets`** — All routes guarded. Key patterns:
- Status transitions run inside a Firestore transaction and write an entry to the `statusHistory` subcollection. The history entry records `previousStatus`, `newStatus`, `changedBy {uid, role}`, `comments`, and `timestamp`.
- Valid statuses: `REPORTADO → REVISION → EN_REPARACION → REPARADO → ENTREGADO → FINALIZADO`. Soft-delete sets status to `ARCHIVADO`.
- Photos stored in Firebase Storage (`repair_photos/<ticketId>/`); public URLs persisted in `photos.evidence[]` / `photos.repair[]`.
- `TicketsController` injects `WhatsappService` to notify the reporter when evidence photos are deleted.
- `POST /api/tickets/import` accepts an `.xlsx` file. Rows are validated against `botConfig.fields`, matched by `field.label` or `field.key`. Phone numbers are normalized (e.g. `3123456789` → `573123456789`). Returns `{ created[], failed[] }` where each failed entry includes the Excel row number (row + 2) and reason.
- `FINALIZADO` tickets older than 30 days are hidden from non-admin queries.

**`whatsapp`** — Marked `@Global()`. Two responsibilities:
1. **Webhook**: `GET /api/whatsapp/webhook` handles Meta verification; `POST /api/whatsapp/webhook` returns 200 immediately and processes in background.
2. **Status listener**: On `OnModuleInit`, opens a Firestore `onSnapshot` on `tickets`. When a status changes, it notifies the reporter via WhatsApp. On `REPARADO`, also sends repair photos.

Bot session state is stored per phone in `whatsapp_sessions/{phone}` using `set({...}, { merge: true })` to avoid clobbering concurrent writes. The `state` field drives a large if/else state machine in `processMessage()`.

**WhatsApp state machine states:**

| State | Description |
|---|---|
| `IDLE` | Main menu (1=create, 2=view, 3=edit, 4=delete) |
| `WAITING_FIELD` | Dynamic field collection loop; driven by `fieldIndex` |
| `WAITING_FIELD_OTHER_RESPONSE` | Free-text fallback when a list field has `allowOther: true` |
| `WAITING_TICKET_SELECTION_VIEW/EDIT/DELETE/FINALIZE` | Ticket picker for each action |
| `WAITING_VIEW_OPTION` | View sub-menu (1=info, 2=photos) |
| `WAITING_EDIT_FIELD_SELECTION` | Choose which field to edit |
| `WAITING_EDIT_FIELD_VALUE` | Enter new value for selected field |
| `WAITING_EDIT_OTHER_RESPONSE` | Free-text fallback for list field edits |
| `WAITING_EDIT_PHOTO_ACTION` | Photo management (1=replace, 2=add) |
| `WAITING_EDIT_ADD_PHOTOS` / `WAITING_EDIT_PHOTO_SELECTION` / `WAITING_EDIT_NEW_PHOTO` | Photo replacement/addition steps |
| `WAITING_ADMIN_REQUESTED_UPDATE` | Admin-triggered field update request |

Session resets to `IDLE` if `lastActivity` elapsed time exceeds `sessionTimeoutHours` (default 24h). The configurable keyword `messages.backToMenuKeyword` (default `"INICIO"`) returns to `IDLE` from any state.

When multiple images arrive concurrently for a photo-type field, a Firestore transaction accumulates them into `tempFieldPhotos[]` atomically before committing. User uploads go to `whatsapp_media/{phone}/{timestamp}_{random}.{ext}` and are made public immediately.

`POST /api/whatsapp/simulate` bypasses Meta — used by the frontend simulator. Accepts `multipart/form-data` (`phone`, optional `message`, optional `files[]`), uploads images to Storage, processes image payloads first then the text payload, and returns `{ responses: string[], photoUrls: string[] }` directly.

`POST /api/whatsapp/bot-toggle` disables automatic replies while preserving message history (live-agent takeover). `POST /api/whatsapp/request-field-update` sets the user's state to `WAITING_ADMIN_REQUESTED_UPDATE` and sends a templated prompt — the user must then use the normal edit flow (option 3) to provide the value.

**`hosts`** — CRUD for the `hosts` Firestore collection. Keyed by phone number. Upserted automatically during ticket import.

**`bot-config`** — Runtime bot configuration. Reads from `bot_config/messages` and `bot_config/ticket_fields` in Firestore. Results cached in-memory for 60 seconds.

`TicketField` key properties:
- `source`: `'bot'` (WhatsApp creation flow) | `'admin'` (admin edits only) | `'auto'` (system-generated, never user-facing)
- `type`: `'string'` | `'numeric'` | `'date'` | `'photo'` | `'video'` | `'boolean'` | `'list'`
- `options[]` + `allowOther` + `otherLabel`: for list type with optional free-text fallback
- `normalize`: forces UPPERCASE and strips accents (NFD) on the stored value
- Keys support dot-notation (e.g. `novelty.type`, `photos.evidence`); `getNestedValue()` / `setNestedValue()` handle arbitrary depth throughout the codebase

The `interpolate(template, vars)` helper replaces `{placeholder}` tokens used across status-change messages, admin prompts, and session-expiry notifications.

### Firestore Collections

| Collection | Purpose |
|---|---|
| `tickets` | Ticket documents; subcollection `statusHistory` per ticket |
| `whatsapp_sessions` | Per-phone bot state + full message history |
| `hosts` | Reporter/agent records keyed by phone |
| `bot_config` | Two documents: `messages` and `ticket_fields` |

### Key Firestore Patterns

- **Transactions** — status transitions and concurrent photo accumulation use `db.runTransaction()` to prevent races.
- **Merge writes** — session updates use `set({...}, { merge: true })` so parallel image arrivals don't overwrite each other.
- **`FieldValue.arrayUnion()`** — used when appending photo URLs to avoid read-modify-write races.

### CORS & prefix

CORS is open (`origin: '*'`). All endpoints are under `/api`.
