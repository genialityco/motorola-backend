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

**`firebase`** — Global singleton. `FirebaseService` exposes `.db` (Firestore), `.auth` (Auth), `.storage` (Storage). Emulator hosts must be set on `process.env` before `initializeApp()`, which this service handles.

**`auth`** — `FirebaseAuthGuard` reads `Authorization: Bearer <token>`, calls `verifyIdToken()`, and attaches the decoded token to `req.user`. Applied per-controller with `@UseGuards(FirebaseAuthGuard)`.

**`tickets`** — All routes guarded. Key patterns:
- Status transitions run inside a Firestore transaction and write an entry to the `statusHistory` subcollection.
- Valid statuses: `REPORTADO → REVISION → EN_REPARACION → REPARADO → ENTREGADO → FINALIZADO`. Soft-delete sets status to `ARCHIVADO`.
- Photos stored in Firebase Storage (`repair_photos/<ticketId>/`); public URLs persisted in `photos.evidence[]` / `photos.repair[]`.
- `TicketsController` injects `WhatsappService` to notify the reporter when evidence photos are deleted.

**`whatsapp`** — Two responsibilities:
1. **Webhook**: `GET /api/whatsapp/webhook` handles Meta verification; `POST /api/whatsapp/webhook` returns 200 immediately and processes in background.
2. **Status listener**: On `OnModuleInit`, opens a Firestore `onSnapshot` on `tickets`. When a status changes, it notifies the reporter via WhatsApp. On `REPARADO`, also sends repair photos.

Bot session state is stored per phone in `whatsapp_sessions/{phone}`. The `state` field drives a large if/else state machine in `processMessage()`. States include: `IDLE`, `WAITING_FIELD`, `WAITING_PHOTOS_AND_DESC`, `WAITING_TICKET_SELECTION_VIEW/EDIT/DELETE/FINALIZE`, `WAITING_EDIT_*`, `WAITING_VIEW_OPTION`. When multiple images arrive concurrently, a Firestore transaction accumulates them into `tempPhotos[]` to avoid races.

`POST /api/whatsapp/simulate` bypasses Meta — used by the frontend simulator. Accepts `multipart/form-data` (`phone`, optional `message`, optional `files[]`), uploads images to Storage, and returns bot responses directly.

**`hosts`** — CRUD for the `hosts` Firestore collection. Keyed by phone number.

**`bot-config`** — Runtime bot configuration. Reads from `bot_config/messages` and `bot_config/ticket_fields` in Firestore. Results cached in-memory for 60 seconds. `TicketField.source === 'bot'` controls which fields appear in the WhatsApp creation flow. The `interpolate()` helper replaces `{placeholder}` tokens in message templates.

### Firestore Collections

| Collection | Purpose |
|---|---|
| `tickets` | Ticket documents; subcollection `statusHistory` per ticket |
| `whatsapp_sessions` | Per-phone bot state + full message history |
| `hosts` | Reporter/agent records keyed by phone |
| `bot_config` | Two documents: `messages` and `ticket_fields` |

### CORS & prefix

CORS is open (`origin: '*'`). All endpoints are under `/api`.
