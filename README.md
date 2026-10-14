# Clinic API

The backend for a prescription-writing app for Pakistani doctors.

The headline feature is voice dictation in mixed Urdu and English: the doctor
dictates, speech-to-text transcribes, an extractor turns the transcript into
_operations_, the server validates and applies those to a prescription draft,
the doctor reviews and approves, and it prints as A4 on the clinic's letterhead.

Three actors:

- **doctor** — writes, approves, dictates, manages locations and staff
- **PA (assistant)** — adds patients to today's list, prints approved prescriptions
- **patient** — later, read-only

Built for one doctor today. Every record is scoped to a _practice_, so the same
code serves a doctor with two locations, or a clinic with several doctors, without
a migration. The UI never says "practice": to the doctor it is his clinic.

## Six rules the code is built around

1. **`practiceId` on every record, filtered in one place.** `core/db/BaseRepository`
   is the only thing that can build a query, and it applies the practice filter,
   the location filter and soft delete itself. No route has to remember.
2. **Soft delete on everything clinical** (`deletedAt`). Locations are _archived_,
   never deleted, because approved prescriptions point at them.
3. **An approved prescription is immutable.** Editing one creates version 2 with
   `previousVersionId` set and marks version 1 `superseded`. Only a `draft` changes.
4. **`letterheadSnapshot` is frozen onto the prescription at approval.** Changing a
   location's address tomorrow cannot alter a page printed today.
5. **Audit log on every write**, append-only.
6. **Voice never writes to a prescription.** It produces `ops`, which the server
   validates and applies. Typed edits go through the same function.

## Getting started

```bash
yarn install
cp .env.example .env       # then open .env and set JWT_SECRET and MONGODB_URL
yarn dev
```

`yarn dev` runs TypeScript directly through ts-node and restarts on a change.
The test suite needs no database of its own — it starts an in-memory mongod.

### Commands

```bash
yarn dev            # development, with reload
yarn build          # compile to dist/
yarn start          # production, via pm2 (dist/index.js)

yarn lint           # eslint, including prettier
yarn lint:fix
yarn typecheck      # tsc --noEmit
yarn test           # jest
yarn test:watch
yarn coverage

yarn docker:dev     # docker compose, with a mongo container
yarn docker:prod
yarn docker:test
```

### Environment

Copy `.env.example`. Everything is validated by zod at boot in
[src/config/config.ts](src/config/config.ts), which fails fast rather than
letting a missing variable become a runtime surprise. The full set:

| Variable                                    | Default        | Notes                                                      |
| ------------------------------------------- | -------------- | ---------------------------------------------------------- |
| `PORT`                                      | `3000`         |                                                            |
| `MONGODB_URL`                               | —              | required; `-test` is appended when `NODE_ENV=test`         |
| `JWT_SECRET`                                | —              | required, at least 16 characters                           |
| `JWT_ACCESS_EXPIRATION_MINUTES`             | `30`           |                                                            |
| `JWT_REFRESH_EXPIRATION_DAYS`               | `30`           |                                                            |
| `OTP_EXPIRATION_MINUTES`                    | `10`           |                                                            |
| `OTP_MAX_ATTEMPTS`                          | `5`            | wrong guesses before the code is burned                    |
| `OTP_COOLDOWN_SECONDS`                      | `60`           | per phone number, survives a restart                       |
| `OTP_LOG_IN_DEV`                            | `true`         | outside production, return the code as `devCode`           |
| `CORS_ORIGINS`                              | dev localhosts | comma separated; **required in production**                |
| `RATE_LIMIT_WINDOW_MINUTES`                 | `15`           |                                                            |
| `RATE_LIMIT_MAX`                            | `300`          | the whole API                                              |
| `AUTH_RATE_LIMIT_MAX`                       | `20`           | sign-in                                                    |
| `OTP_RATE_LIMIT_MAX`                        | `5`            | keyed on the phone number, not the IP                      |
| `STORAGE_DRIVER`                            | `local`        | `local` or `s3`                                            |
| `STORAGE_LOCAL_DIR`                         | `.storage`     | for the `local` driver                                     |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT`   | —              | any S3 or R2 bucket                                        |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | —              |                                                            |
| `S3_FORCE_PATH_STYLE`                       | `true`         | needed by R2 and MinIO                                     |
| `SIGNED_URL_TTL_SECONDS`                    | `300`          | audio and PDF links                                        |
| `MAX_AUDIO_UPLOAD_MB`                       | `20`           | per dictation segment                                      |
| `SMS_PROVIDER`                              | `log`          | sign-in codes and "you were added"                         |
| `SMS_SENDER_ID`                             | `Clinic`       |                                                            |
| `STT_PROVIDER`                              | `none`         | `none` or `mock`; see **Voice** below                      |
| `LLM_PROVIDER`                              | `none`         | `none` or `mock`                                           |
| `VOICE_SEGMENT_TIMEOUT_MS`                  | `90000`        | a stalled segment is failed, not left hanging              |
| `PDF_RENDERER_URL`                          | —              | an HTML-to-PDF service; without one the print file is HTML |
| `AUDIO_RETENTION_DAYS`                      | `30`           | default for a new practice, days after approval            |

## Layout

```
src/
  shared/          zod schemas + inferred types - the wire contract, imported by the app too
  core/
    db/            BaseRepository: the only query builder, with the practice filter
    tenancy/       resolvePractice (X-Practice-Id), resolveLocation (X-Location-Id)
    permissions/   can(role, action) - one table
    errors/        AppError and the fixed error-code enum
    events/        a typed EventEmitter bus
    audit/         the append-only write log
    storage/       S3/R2 and local drivers, signed URLs
    sms/           provider adapter
  config/          zod-validated env, winston, morgan
  models/          the 18 collections, their indexes, and syncCollections()
  services/        the work
  controllers/     thin: call a service, send the envelope
  routes/v1/       every route, with its middleware chain spelled out
  validations/     request wiring: shared schemas assembled per route
  middlewares/     requestId, requireAuth, validate, rateLimiter, error, notImplemented
  listeners/       what an event causes - notifications, SMS
  utils/
tests/
  integration/     through the app, over HTTP
  unit/            pure logic
  fixtures/        sign-in and clinic helpers
```

`src/shared` is the single source of truth for every shape that crosses the wire.
It imports nothing but zod — no express, no mongoose, no node built-ins — because
the React Native app imports it too. Change a prescription section there and both
sides change at once; that is the whole point of the folder.

## The request pipeline

```
requestId → logger → rateLimit → requireAuth → resolvePractice
  → resolveLocation (scoped routes) → can(action) → validate(schema)
  → handler → errorHandler
```

The first three are mounted app-wide. The rest are declared on each route, so
reading a route file tells you who may call it and with what.

## Responses

Success:

```json
{ "data": {}, "meta": { "page": 1, "limit": 20, "total": 42, "totalPages": 3 } }
```

Failure:

```json
{
  "error": {
    "code": "RX_LOCKED",
    "message": "This prescription is approved. Revise it to make a new version.",
    "details": null
  }
}
```

`code` is one of the values in [src/shared/errorCodes.ts](src/shared/errorCodes.ts)
and it is the contract: the app switches on the code, never on the message or the
HTTP status. Each code has exactly one status, mapped in that same file, so a new
code cannot be added without deciding what it answers with. `details` carries a
field-by-field list on a validation failure.

Every response carries `X-Request-Id`, echoing an inbound one if it looks sane, so
a report from the app can be traced to the request that caused it.

## Routes

Base path `/api/v1`. Everything except `/auth` needs `X-Practice-Id`; `/me` is the
exception that proves the rule, since its answer is what tells the app which
practice ids exist. Visits, prescriptions and voice also need `X-Location-Id`.

| Module        | Routes                                                                                                                                                     | Who                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| auth          | `POST /auth/otp/send`, `/auth/otp/verify`, `/auth/refresh`, `/auth/logout`                                                                                 | anyone                  |
| me            | `GET /me`, `PATCH /me`                                                                                                                                     | signed in               |
| practice      | `GET /practice`, `PATCH /practice`                                                                                                                         | doctor                  |
| locations     | `GET`/`POST /locations`, `PATCH /locations/:id`, `POST /locations/:id/archive`                                                                             | doctor                  |
| team          | `GET`/`POST /members`, `PATCH /members/:id`, `DELETE /members/:id`                                                                                         | doctor                  |
| patients      | `GET /patients?q=`, `POST /patients`, `GET`/`PATCH /patients/:id`                                                                                          | doctor, PA              |
| visits        | `GET /visits?date=today`, `POST /visits`, `PATCH /visits/:id`                                                                                              | doctor, PA              |
| prescriptions | `POST /prescriptions`, `GET`/`PATCH /prescriptions/:id`, `POST /prescriptions/:id/approve`, `POST /prescriptions/:id/revise`, `GET /prescriptions/:id/pdf` | doctor (PA: read + pdf) |
| voice         | `POST /prescriptions/:id/voice/segments`, `GET /prescriptions/:id/voice`, `POST /voice/segments/:id/retry`, `GET /voice/segments/:id/audio`                | doctor                  |
| drugs         | `GET /drugs?q=`                                                                                                                                            | doctor                  |

Mounted and answering **501**, so the app can link to them and nothing is renamed
when they go live: `/devices`, `/templates`, `/patients/:id/history`,
`/portal/*`, `/prescriptions/from-template/:id`.

In development, `GET /api/v1/docs` serves the OpenAPI document.

## The assistant's screens

The PA's day runs on four things, all of them live.

**Today's queue.** Each visit carries a `token` - the number called out in the
waiting room, starting at 1 each day at each location. It comes from an atomic
counter in `counters`, so two registrations in the same second cannot collide,
and it is never reused: a removed visit takes its number with it, because
whoever is holding that slip has already heard it called. `statusChangedAt` is
what "went in 6 min ago" counts from, and it moves on a status change and not
on any other edit. `vitalsRecordedAt` is how the queue knows to offer "Add
vitals" or report "Vitals done".

**Registering a patient.** Every patient gets an `mrNo` like `MR-10001`,
sequential within a practice from an atomic `$inc` on `practice.mrCounter`.
Search matches a name, an MR number (with or without the prefix, in any case)
or a phone prefix; a bare number is tried as both, because at the desk "10001"
is as likely to be a file number as the start of a phone. `allergies` and
`noKnownAllergies` are kept apart on purpose: an empty list cannot tell you
whether anybody asked, and that distinction matters on a prescription. A record
that claims both is refused, including when the two halves arrive in separate
requests.

**Vitals.** `PUT /visits/:id/vitals` creates or replaces the one set of
readings for a visit - a correction to a reading taken two minutes ago is a
correction, not a second set of observations, and the previous values go into
the audit entry. Normal ranges and the `vitalFlags()` that applies them live in
[src/shared/vitals.schema.ts](src/shared/vitals.schema.ts) rather than on the
server alone: the app highlights a reading as it is typed and the server flags
the same reading for the doctor, and the two disagreeing in front of a patient
would be worse than either being slightly wrong.

**Reports.** Uploaded in two steps, because a phone photo of a lab sheet is
several megabytes and should not pass through a request handler. `POST
/reports/uploads` hands back a presigned PUT; `POST /patients/:id/reports`
records what landed. A key issued to another clinic is refused. With the local
storage driver there is nothing to sign against, so step one answers
`STORAGE_UNAVAILABLE` and says to set `STORAGE_DRIVER=s3`.

**Being added.** When the doctor adds a number, that person gets a text —
"Dr. Ayesha Khan added you to Shifa Clinic. Install the clinic app and sign in
with this number." — naming who added them, because this arrives unprompted on
the phone of somebody who may not be expecting it. It says nothing about their
role. A number that is already a member is refused before any message is sent,
and a gateway that is down is logged and ignored: the member has still been
added. Outside production the `log` provider prints the whole message, so it
can be read on a dev box with no gateway.

**The schedule.** Appointments are location-scoped and a slot is held by a
unique partial index rather than by a check two simultaneous bookings would
both pass; the second gets `CONFLICT`. Cancelling frees the slot and leaves the
booking on record. `GET /follow-ups` is derived, not stored: an approved
prescription whose `followUp` has a date, with no booked appointment pointing
back at it. Booking one with its `prescriptionId` is what takes it off the
list, so there is no second list to keep in step.

## Permissions

| Action                                            | Doctor                       | PA                 |
| ------------------------------------------------- | ---------------------------- | ------------------ |
| add / edit patient                                | yes                          | yes                |
| search patients                                   | yes                          | yes                |
| see today's list                                  | any location of his practice | her locations only |
| create / edit / approve prescription              | yes                          | **no**             |
| view / print approved prescription                | yes                          | her locations only |
| voice dictation                                   | yes                          | **no**             |
| add / remove PA, assign locations                 | yes                          | no                 |
| add / edit / archive locations, practice settings | yes                          | no                 |

The table lives in [src/core/permissions/index.ts](src/core/permissions/index.ts).
Location scope is not in it, because it is not a question of role: `resolveLocation`
holds a PA to the locations she was assigned and lets a doctor name any location of
his own practice.

## Auth

Phone and a one-time code. There is no password anywhere in this product.

- `POST /auth/otp/send` issues a six digit code from a CSPRNG, stores it
  bcrypt-hashed, and texts it. Any code still outstanding for that number is
  deleted first, so only the most recent one verifies — which is what makes
  "resend" safe. Outside production the code comes back as `devCode`.
- `POST /auth/otp/verify` consumes it. A wrong guess is counted; too many burn the
  code. The code is single use.
- `OTP_FIXED_CODE=123456` makes every sign-in use that code, so a client can be
  tested without an SMS gateway. Only the value changes: it is still hashed, still
  expires, still counts attempts, is still single use, and still has to have been
  sent to that number first — it is not a master key. It is forced off in
  production, because with it set anybody who knows a phone number can sign in as
  its owner. [tests/unit/config/config.test.ts](tests/unit/config/config.test.ts)
  holds that guard down.
- A phone number that verifies is a person, so there is no separate sign-up
  endpoint. Whether that person also gets a clinic is decided by `intent` on the
  verify body: `signUp` (the "set up your clinic" button) creates a practice, one
  location called "My clinic" and a doctor membership — but only for someone with
  no memberships at all. `signIn` never creates anything, and is the default, so
  the cautious answer is the one a caller gets by omission.
- A `signIn` from a number nobody has added **succeeds**, with
  `memberships: []`. That is the app's "this number isn't linked to a clinic yet"
  screen. Its "set up my clinic" button calls `POST /practices`, which runs the
  same bootstrap for a caller who is already signed in — no second code — and
  answers `CONFLICT` if they already belong to one. It takes no `X-Practice-Id`,
  because the whole point is that there is not one yet.
- This matters more than it looks: bootstrapping on "no memberships" alone meant
  an assistant who opened the app before the doctor added her got a clinic of her
  own, was walked through doctor setup, and then belonged to two.
- Refresh tokens are stored as a SHA-256 and consuming one deletes it, so a replay
  fails. Every token carries a `jti`, because `iat` has one-second resolution and
  two tokens signed in the same second would otherwise be identical.
- Membership is read on **every** request rather than carried in the token, so
  removing a PA ends her access now, not when her token expires.

## Prescriptions

A draft is edited only through **ops**:

```json
{
  "ops": [
    {
      "op": "add",
      "section": "medicines",
      "value": {
        "name": "Panadol",
        "strength": "500mg",
        "pattern": { "m": 1, "a": 0, "n": 1 },
        "timing": "after_meal",
        "durationDays": 5
      }
    },
    { "op": "update", "section": "followUp", "value": { "inDays": 7 } }
  ]
}
```

`op` is `add`, `update` or `remove`; `section` is one of the nine list sections or
`followUp`, which only updates. An `add` never carries an id — the server mints one.
An `update` or `remove` addresses an existing `itemId`.

The whole batch is validated before any of it is applied
([prescriptionOps.service.ts](src/services/prescriptionOps.service.ts)). Two
reasons: a bad op halfway through would otherwise leave a prescription half
edited, and this is the gate rule 6 rests on. An op that names a section that does
not take it, invents a field, or addresses an item that is not there comes back as
`OP_INVALID`.

**Approval** mints the number with one atomic `$inc` on the practice counter —
never read-then-write, which is how two prescriptions end up with the same number
on a legal document — freezes the letterhead, and locks the document. **Revising**
creates version 2 and marks version 1 `superseded`, so what the patient was handed
stays exactly as it was printed.

The print file is rendered on first ask rather than at approval, so an approval
never waits on a renderer. With `PDF_RENDERER_URL` set, the HTML is posted there
and the PDF stored; without one, the HTML is stored and `meta.format` says so.

`editLog` records every typed correction and `correctedBySpeech` marks every
dictated one. Together they are how the accuracy of the voice pipeline gets
measured over real use.

## Voice

One segment of audio at a time, base64 inside the JSON body, with `seq` strictly
one more than the last: an upload that skips ahead is refused rather than quietly
reordered, because the ops of segment 3 can refer to a line segment 2 was about to
add. Transcription runs in process and the app polls
`GET /prescriptions/:id/voice`.

```
audio → transcript + spans → ops → server validates → server applies
```

Every line on the page keeps the `sourceSpanIds` it came from, so it can always be
traced back to what was said.

**The transcriber and the ops extractor are seams, and default to `none`**, which
fails a segment with a clear error. Choosing them is a decision about accuracy on
Pakistani code-switched speech and about where patient audio is allowed to go, and
it is not made here; what is settled is the contract on either side. Implement
[stt.service.ts](src/services/stt.service.ts) and
[llm.service.ts](src/services/llm.service.ts) and nothing else changes. The `mock`
drivers read the upload as UTF-8 text and accept a JSON array of ops, which is how
the ordering, validation, apply and audit path is tested end to end.

Two things keep the queue from wedging: a timeout that fails a segment so the ones
behind it move, and a sweep that does the same for a segment whose processing began
before the process restarted. Dictation audio is deleted once the practice's
retention has run out — the transcript stays, the recording of a patient's voice
does not.

## Conventions

- **Ids** are Mongo ObjectIds. Human-readable numbers only where they are printed.
- **Time** is stored in UTC and shown in `Asia/Karachi`. Pakistan is UTC+05:00 all
  year and has not observed daylight saving since 2009, so
  [utils/time.ts](src/utils/time.ts) uses a fixed offset rather than a timezone
  database. A visit's `date` is the Karachi calendar day as `YYYY-MM-DD`: a day on
  a waiting list has no time of day.
- **Phones** are E.164 (`+923001234567`), unique on users.
- **Every document** carries `practiceId`, `createdAt`, `updatedAt`, `createdBy`.
  Compound indexes start at `practiceId` and continue with `locationId` where a
  record belongs to a place.
- **Location scope**: visits, prescriptions and voice. Patient search and history
  are practice-wide **on purpose**.
- **Bilingual** fields that print in Urdu hold `{ en, ur }`.
- **Feature flags** live on `practice.features`.
- **Naming**: collections plural camelCase, events `entity.pastTense`, permissions
  `entity.verb`.
- **Private files**: audio and PDFs in private object storage only, served by short
  signed URLs. No patient names in logs or in object keys. The application log
  carries ids and masked phone numbers; the before/after of a record belongs in the
  audit log.

## Events

`patient.added`, `visit.statusChanged`, `voice.segmentApplied`,
`voice.segmentFailed`, `prescription.approved`, `prescription.revised`,
`member.added`, `member.removed`, `member.locationsChanged`, `location.added`,
`location.archived`, `report.uploaded`.

Services emit; [src/listeners](src/listeners) decides what they cause. No service
calls notification or SMS code directly, so adding push later means adding a
handler and editing no prescription code.

## Deliberately not built yet

- **No queue and no SSE.** Transcription, extraction and PDF rendering run in
  process and the app polls. Both are worth adding when load asks for them, and
  the housekeeping sweeps in [src/index.ts](src/index.ts) are plain timers for the
  same reason.
- **No formulary import.** `drugs` starts empty and grows from use: a medicine
  nobody has prescribed before is inserted, and the next time it matches. A
  doctor's working repertoire is 200-400 drugs, so a text index with a prefix
  fallback is plenty and Atlas Search is not needed.
- **No push.** `POST /devices` answers 501. The inbox itself is live and the
  rows have been written since the first commit, so there was nothing to
  backfill when it went in.

## Testing

```bash
yarn test
```

Hermetic: each test file starts its own in-memory mongod and builds the real
indexes, so the unique and text indexes the code relies on are actually exercised.
No local mongod, no CI service container.

The suites that exist to hold the six rules down:

| File                                                                                       | What it proves                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [tests/integration/tenancy.test.ts](tests/integration/tenancy.test.ts)                     | practice A cannot read or write practice B's patients; a PA is held to her own locations; removing her ends her session now                                  |
| [tests/integration/prescription.test.ts](tests/integration/prescription.test.ts)           | an approved prescription cannot be mutated; a revise makes v2 and supersedes v1; the letterhead stays frozen; concurrent approvals never collide on a number |
| [tests/integration/voice.test.ts](tests/integration/voice.test.ts)                         | ops are validated by the server before they are applied; segments apply in order; audio retention deletes the recording and keeps the transcript             |
| [tests/integration/routes.test.ts](tests/integration/routes.test.ts)                       | every route in the table responds, with real data or 501                                                                                                     |
| [tests/unit/services/prescriptionOps.test.ts](tests/unit/services/prescriptionOps.test.ts) | the ops engine, including that one bad op discards the whole batch                                                                                           |
| [tests/unit/core/permissions.test.ts](tests/unit/core/permissions.test.ts)                 | the permissions table, read straight across                                                                                                                  |
