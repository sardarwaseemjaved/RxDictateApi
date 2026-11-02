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
a migration. The UI never says "practice": to the doctor it is their clinic.

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

Deploying to a server: [deploy/README.md](deploy/README.md).

### Environment

Copy `.env.example`. Everything is validated by zod at boot in
[src/config/config.ts](src/config/config.ts), which fails fast rather than
letting a missing variable become a runtime surprise. The full set:

| Variable                                    | Default                       | Notes                                                                                                                   |
| ------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                      | `3000`                        |                                                                                                                         |
| `TRUST_PROXY`                               | `0`                           | proxies in front of the API; `1` behind nginx                                                                           |
| `MONGODB_URL`                               | —                             | required; `-test` is appended when `NODE_ENV=test`                                                                      |
| `JWT_SECRET`                                | —                             | required, at least 16 characters                                                                                        |
| `JWT_ACCESS_EXPIRATION_MINUTES`             | `30`                          |                                                                                                                         |
| `JWT_REFRESH_EXPIRATION_DAYS`               | `30`                          |                                                                                                                         |
| `OTP_EXPIRATION_MINUTES`                    | `10`                          |                                                                                                                         |
| `OTP_MAX_ATTEMPTS`                          | `5`                           | wrong guesses before the code is burned                                                                                 |
| `OTP_COOLDOWN_SECONDS`                      | `60`                          | per phone number, survives a restart                                                                                    |
| `OTP_LOG_IN_DEV`                            | `true`                        | outside production, return the code as `devCode`                                                                        |
| `CORS_ORIGINS`                              | dev localhosts                | **required in production**; must list the web app — see below                                                           |
| `RATE_LIMIT_WINDOW_MINUTES`                 | `15`                          |                                                                                                                         |
| `RATE_LIMIT_MAX`                            | `300`                         | the whole API                                                                                                           |
| `AUTH_RATE_LIMIT_MAX`                       | `20`                          | sign-in                                                                                                                 |
| `OTP_RATE_LIMIT_MAX`                        | `5`                           | keyed on the phone number, not the IP                                                                                   |
| `VERIFY_RATE_LIMIT_MAX`                     | `30`                          | per minute per IP, both public verify routes together                                                                   |
| `PUBLIC_API_URL`                            | this machine's LAN address    | where download links point; set it behind a proxy                                                                       |
| `VERIFY_BASE_URL`                           | `http://{LAN address}:5173/v` | **required in production**; the web app's `/v` page, which a printout's QR code links to — see **Verifying a printout** |
| `STORAGE_DRIVER`                            | `local`                       | `local` or `s3`                                                                                                         |
| `STORAGE_LOCAL_DIR`                         | `.storage`                    | for the `local` driver                                                                                                  |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT`   | —                             | any S3 or R2 bucket                                                                                                     |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | —                             |                                                                                                                         |
| `S3_FORCE_PATH_STYLE`                       | `true`                        | needed by R2 and MinIO                                                                                                  |
| `SIGNED_URL_TTL_SECONDS`                    | `300`                         | audio and PDF links                                                                                                     |
| `MAX_AUDIO_UPLOAD_MB`                       | `20`                          | per dictation segment                                                                                                   |
| `SMS_PROVIDER`                              | `log`                         | sign-in codes and "you were added"                                                                                      |
| `SMS_SENDER_ID`                             | `Clinic`                      |                                                                                                                         |
| `STT_PROVIDER`                              | `none`                        | `none`, `mock` or `openai`; see **Voice** below                                                                         |
| `LLM_PROVIDER`                              | `none`                        | `none`, `mock` or `openai`                                                                                              |
| `OPENAI_API_KEY`                            | —                             | required when either provider is `openai`; boot fails without it                                                        |
| `OPENAI_BASE_URL`                           | `https://api.openai.com/v1`   |                                                                                                                         |
| `OPENAI_MODEL`                              | `gpt-4o-mini`                 | turns a transcript into ops                                                                                             |
| `OPENAI_STT_MODEL`                          | `gpt-4o-transcribe`           | transcription                                                                                                           |
| `VOICE_SEGMENT_TIMEOUT_MS`                  | `90000`                       | a stalled segment is failed, not left hanging                                                                           |
| `PDF_RENDERER_URL`                          | —                             | an HTML-to-PDF service; without one the print file is HTML                                                              |
| `AUDIO_RETENTION_DAYS`                      | `30`                          | default for a new practice, days after approval                                                                         |

**`CORS_ORIGINS` and the web app.** Comma separated. Setting it **replaces** the
dev defaults (`http://localhost:3000`, `:5173`, `:8081`, `:19006`) rather than
adding to them. The web app calls this API from the browser, and with the local
storage driver it also PUTs report pages straight to `PUBLIC_API_URL`, so the
web app's address must be on the list. In dev that is `http://localhost:5173`:
a `.env` that sets `CORS_ORIGINS` has to include it itself. The native app
sends no `Origin` and is never affected.

**Bucket CORS, for production.** With `STORAGE_DRIVER=s3` the browser PUTs
report pages straight to the bucket. That request is cross-origin, and the
bucket refuses it unless its own CORS rules allow it — without this rule every
browser upload fails before it reaches the API, while the phone app (which
sends no `Origin`) carries on working, which makes it easy to miss.

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`AllowedOrigins` is the web app's addresses. On R2 the rule goes in the
bucket's **Settings → CORS policy**; on S3, in the bucket's **Permissions →
Cross-origin resource sharing**, or `aws s3api put-bucket-cors` with the array
wrapped as `{ "CORSRules": [...] }`.

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
    realtime/      the WebSocket: handshake, open connections, deliver()
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
  listeners/       what an event causes - notifications, SMS, realtime messages
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
Two kinds of route are public and need neither header: `/verify`, which a
printout's QR code leads to, and `/files`, where a signed link is the credential.

| Module        | Routes                                                                                                                                                                                       | Who                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| auth          | `POST /auth/otp/send`, `/auth/otp/verify`, `/auth/refresh`, `/auth/logout`                                                                                                                   | anyone                            |
| auth          | `POST /auth/logout-all`                                                                                                                                                                      | signed in — **501**               |
| me            | `GET /me`, `PATCH /me`                                                                                                                                                                       | signed in                         |
| practice      | `GET /practice`, `PATCH /practice`                                                                                                                                                           | doctor                            |
| locations     | `GET`/`POST /locations`, `PATCH /locations/:id`, `POST /locations/:id/archive`                                                                                                               | doctor                            |
| team          | `GET`/`POST /members`, `PATCH /members/:id`, `DELETE /members/:id`                                                                                                                           | doctor                            |
| patients      | `GET /patients?q=`, `POST /patients`, `GET`/`PATCH /patients/:id`                                                                                                                            | doctor, PA                        |
| visits        | `GET /visits?date=today`, `POST /visits`, `PATCH /visits/:id`, `POST /visits/:id/move`                                                                                                       | doctor, PA                        |
| prescriptions | `POST /prescriptions`, `GET`/`PATCH /prescriptions/:id`, `POST /prescriptions/:id/approve`, `POST /prescriptions/:id/revise`, `GET /prescriptions/:id/preview`, `GET /prescriptions/:id/pdf` | doctor (PA: read + preview + pdf) |
| voice         | `POST /prescriptions/:id/voice/segments`, `GET /prescriptions/:id/voice`, `POST /voice/segments/:id/retry`, `GET /voice/segments/:id/audio`                                                  | doctor                            |
| drugs         | `GET /drugs?q=`                                                                                                                                                                              | doctor                            |
| history       | `GET /patients/:id/history?kind=`                                                                                                                                                            | doctor                            |
| reports       | `POST /reports/uploads`, `POST`/`GET /patients/:id/reports`, `GET /reports/:id`                                                                                                              | doctor, PA                        |
| reports       | `POST /reports/:id/review`                                                                                                                                                                   | doctor                            |
| templates     | `GET`/`POST /templates`, `GET`/`PATCH`/`DELETE /templates/:id`, `POST /prescriptions/from-template/:id`                                                                                      | doctor                            |
| files         | `GET`/`PUT /files/<key>?…&sig=` — local storage driver only                                                                                                                                  | whoever holds the signed link     |
| verify        | `GET /verify/:code`, `GET /verify/:code/qr.svg` — see **Verifying a printout**                                                                                                               | anyone, 30 a minute per address   |

`GET /prescriptions` takes `from`, `to` (Karachi days, inclusive) and `q` (a
patient's name, phone or MR number, matched as patient search matches them), and
each row carries `patient: { id, name, age, sex, mrNo }` so a list of every
prescription needs no request per row. The single read does not.

Mounted and answering **501**, so the app can link to them and nothing is renamed
when they go live: `/devices`, `/portal/*`.

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

**The order of the list.** The assistant calls patients in, so the assistant
decides who goes next, and the doctor's screens show the same order.
`POST /visits/:id/move` with `{ before }` puts a waiting visit just before
another waiting visit, or after every other waiting one when `before` is null,
and `GET /visits` returns the day by `queuePosition`, then token. The token never
changes: a number out of sequence is how the room can tell the list was
rearranged. A new visit starts at its token, and no move puts a visit at or past
the next token, so the newest is always last. A move writes one row, halfway
between its new neighbours, and renumbers the day only when no number fits
between them. Two moves of the same list take turns on a short lease in
`counters` in place of a transaction, which a standalone mongod cannot open.
Visits from before the field existed get their token as their position at boot.

**Whose patients.** A patient belongs to the clinic and is linked to locations:
where they were registered (`X-Location-Id` on `POST /patients`; without one, an
assistant's own locations or the doctor's default location), and every location
they have a visit or an appointment at. Links are only ever added. The doctor
sees every patient. An assistant sees the ones linked to a location they work
at - in search, the list, its totals and its counts, and by id - and anyone else
is `NOT_FOUND`, never `FORBIDDEN`, because whether they exist is not that
assistant's business. Every service reaches a patient through `findPatient` in
[patient.service.ts](src/services/patient.service.ts), so the rule lives in one
place. The lists of visits, appointments, follow-ups and prescriptions are already
held to a location, and each of those records links its patient there when it is
made. The one way across is a whole phone number: an assistant who types it finds
the patient wherever they were registered, and for 30 minutes may open them and
add them to the list or book them at their own location, which links them there
instead of registering the same person twice (`patientIntroductions` keeps that
half hour). Locations are read from the membership on every request, so taking
one away hides its patients at once. Patients from before links existed are
linked at boot from their visits, appointments and prescriptions; one an
assistant registered also gets that assistant's locations, and one linked
nowhere goes to the default location.

**The patients list.** Patients carry `conditions` alongside `allergies`, and a
read-only `lastVisitDate` the screen shows as "Today", "Yesterday" or a date.
That date is derived from the visits but kept on the patient, because the list
sorts by it (`sort=lastVisit`; `name` is still the default) and a sort cannot
reach into another collection without an aggregation that paging then has to
fight. It is maintained in one place with a `$max`, so a backdated visit cannot
pull it backwards.

Two filters back the design's chips, and `meta.counts` carries their totals on
every list so a chip never shows a blank number: `followUpDue=true` is an
approved follow-up whose date has passed with no visit since, worked out from
the prescriptions rather than stored so it cannot go stale, and
`newReports=true` is a report nobody has marked reviewed. Both at once means
both. The counts ignore `q` and the active filter, because that is what a chip
count means.

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
storage driver the API stands in for the bucket: the upload URL is its own
`PUT /api/v1/files/<key>?expires=&ct=&size=&sig=`, HMAC'd over the key, the
expiry, the content type and the declared size. It refuses an expired or
altered link (`FORBIDDEN`), a body sent with a different `Content-Type` or
larger than the signed size (`VALIDATION_ERROR`, checked against
`Content-Length` before a byte is read), and answers like a bucket — 200 and an
`ETag` — so the app does not need to know which it uploaded to. A download link
cannot be turned into an upload link: the two are signed over different
strings. Browser uploads need CORS on the bucket in production; see
**Environment**.

`POST /reports/:id/review` is the doctor marking a report looked at. It sets
`reviewedAt` and `reviewedBy`, which is what takes the report out of "New" and
the patient out of `newReports=true`. Reviewing again keeps the first time, and
a filter on `reviewedAt: null` makes that hold when two devices tap at once. It
is audited and tells nobody.

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

A booking becomes `arrived` when a visit is created for that patient on its day
at its location — by the assistant adding them to the list, or by the doctor
starting a prescription, which does the same. The Schedule lists `booked` and
`arrived` together, so it shows who came, and an arrived follow-up stays off
the to-book list. Nothing makes a visit from an appointment. This is not a
transaction: nothing here uses one and the standalone mongod of dev and the
tests cannot. The visit is written first, so a failure in between leaves a
patient on the list whose booking still says booked, rather than an arrival
nobody registered.

`appointment.booked` goes to the assistants who work at that location, leaving
out whoever made the booking. Not to the doctor, who has no schedule page for it
to open.

## Patient history

`GET /patients/:id/history` is one column, newest first: visits with their
vitals, prescriptions (every status but `cancelled`), labs and reports, shaped
by [src/shared/history.schema.ts](src/shared/history.schema.ts). `kind=` narrows
it to one. Practice-wide, like the doctor's search, because a patient seen at two
locations has one history, and the doctor's alone.

The merge and the paging are done by the database: each collection contributes
its ids and `at` to a `$unionWith`, the union is sorted and one page is cut, and
only that page is read in full. `at` is when the item reached the record; a
report's `testDate` and a visit's `date` say when the thing itself happened.

Labs are the tests an approved prescription ordered: approving one writes a
`labs` row per line of its labs section, with an empty `result`. Approving a
revision retires the previous version's rows that have no result or file yet
and writes its own, so a re-ordered test is not listed twice and a test with a
result is never lost. Prescriptions approved before this went in have no rows.

## Rx templates

A template is a saved set of the same sections a prescription carries, so
applying one is a copy. It belongs to the doctor who made it: two doctors at
one clinic each keep their own, and another doctor's template is a 404. A
template is a prescribing habit, and a colleague's regimen should not turn up
on a page this doctor signs.

Whichever way one is made, it keeps the follow-up's interval and drops its
date, and drops every flag, `correctedBySpeech` and source span — a flag carried
into a template would block approval of every prescription started from it.
"Save as template" (`fromPrescriptionId`) copies an approved prescription and
leaves its complaints, history and examination behind, because those describe
the patient it was written for. Names are unique per doctor in any case.

`POST /prescriptions/from-template/:id` with `{ patientId, visitId? }` finds the
visit as `POST /prescriptions` does. With no open draft it makes one, `source:
'template'`, 201. With one, it adds the template's lines to it, 200: a line the
draft already has is skipped rather than doubled, the follow-up is taken only
when the draft has none, and nothing is removed. The lines go through the ops
engine, so they are validated and get fresh ids, with their own origin so they
do not count as the doctor correcting the dictation. Each use adds one to
`useCount` and sets `lastUsedAt`, without moving `updatedAt`. The list is most
used first.

`practice.features.templates` is not enforced: neither app reads it, and its
default of `false` would switch templates off for every clinic.

## Permissions

| Action                                            | Doctor                         | PA                      |
| ------------------------------------------------- | ------------------------------ | ----------------------- |
| add / edit patient                                | yes                            | yes                     |
| search patients                                   | yes                            | yes                     |
| a patient's history                               | yes                            | **no**                  |
| see today's list                                  | any location of their practice | assigned locations only |
| create / edit / approve prescription              | yes                            | **no**                  |
| view / print approved prescription                | yes                            | assigned locations only |
| voice dictation                                   | yes                            | **no**                  |
| file a report                                     | yes                            | yes                     |
| mark a report reviewed                            | yes                            | **no**                  |
| Rx templates                                      | their own                      | **no**                  |
| add / remove PA, assign locations                 | yes                            | no                      |
| add / edit / archive locations, practice settings | yes                            | no                      |

The table lives in [src/core/permissions/index.ts](src/core/permissions/index.ts).
Location scope is not in it, because it is not a question of role: `resolveLocation`
holds a PA to the locations they were assigned and lets a doctor name any location
of their own practice.

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
  an assistant who opened the app before the doctor added them got a clinic of
  their own, was walked through doctor setup, and then belonged to two.
- **Signing in creates a session**, one row per device. An access token is a signed
  claim that cannot be withdrawn, so without a record on this side a phone that
  signed out would keep working until its token happened to expire. `requireAuth`
  checks both halves on every request: the token says who and which session, the
  session says whether that is still true.
- The access token carries `sub` and `sid` and nothing else — no role, no practice.
  Both are resolved per request from memberships.
- The refresh token is 32 random bytes with its family in front, and only its
  SHA-256 is stored. It is replaced on every refresh. A token that comes back after
  being rotated means two holders and no way to tell which is the phone, so the
  session ends with `reuse_detected` — the newer token included. The family is what
  makes a retired token recognisable at all, since only the current hash is kept.
- **Verifying on a device retires that device's previous session**, so one phone
  holds one session. `deviceId` is generated by the app on first install.
- `POST /auth/logout` is idempotent and never fails. It identifies the session from
  the access token — **even an expired one** — or from the refresh token in the body,
  so a phone that was asleep can still sign out cleanly instead of leaving a live
  session behind. It clears that phone's push token, emits `session.revoked`, and
  audits `auth.logout` with the device, the platform and the IP, and no token.
- A session's expiry slides forward on each refresh, capped at `SESSION_MAX_DAYS`
  from the sign-in. A nightly sweep marks a lapsed session revoked; the TTL index
  removes the row a month later.
- Membership is read on **every** request rather than carried in the token, so
  removing a PA ends their access to that clinic now, not when their token expires.
  Their **session is deliberately left alone**: they may work at another clinic on
  the same sign-in. `resolvePractice` answers `MEMBERSHIP_REMOVED` for a clinic they
  were taken off and `NOT_MEMBER` for one they were never on, because the app says
  different things about them.

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

An `update` op changes only the fields it carries. The item schemas have
defaults, and `.partial()` does not stop a default firing for a key that was
left out, so the parsed value is narrowed back to the keys that were actually
sent — otherwise confirming a medicine by name would reset its dose, strength,
form and duration. An `add` still fills the defaults in.

The whole batch is validated before any of it is applied
([prescriptionOps.service.ts](src/services/prescriptionOps.service.ts)). Two
reasons: a bad op halfway through would otherwise leave a prescription half
edited, and this is the gate rule 6 rests on. An op that names a section that does
not take it, invents a field, or addresses an item that is not there comes back as
`OP_INVALID`.

**The visit follows the prescription.** A doctor working alone never touches
the queue. `POST /prescriptions` with no `visitId` puts the patient on today's
list at the active location - finding the visit they are already on, token and
all - and attaches the draft to it. Starting a prescription moves a `waiting`
visit to `with_doctor`; approving one moves it to `done`. On the server rather
than in the app, so every client does it and it cannot half happen because a
second request was lost.

**Starting one.** `POST /prescriptions` with a `visitId` returns the draft that
visit already has rather than opening a second — 200 for the existing one, 201
for a new one — and a unique partial index decides it, so two devices tapping
at once cannot both win. On creation only, any complaints the assistant
recorded with the vitals are added to the draft through the ordinary op path,
so they land in the edit log like any other change and a later edit is never
overwritten.

**Approval** mints the number with one atomic `$inc` on the practice counter —
never read-then-write, which is how two prescriptions end up with the same number
on a legal document — freezes the letterhead, and locks the document. **Revising**
opens version 2 as a draft and leaves version 1 **approved** until version 2 is
signed — so a doctor who starts a revision and is called away has not left the
patient without a valid prescription. Signing version 2 is what retires version
1, and in that order on purpose: there are no transactions here, and two
approved versions is a state somebody can see and fix, where none is not.
`GET /prescriptions/:id` carries `revisionId` while one is open, a second
revise answers `CONFLICT` with that id, and a unique partial index decides it
when two taps arrive together. Nothing about version 1 ever changes but its
status, so what the patient was handed stays exactly as it was printed.

Approval is refused with `RX_HAS_FLAGS` while any medicine still carries one. A
flag is the pipeline saying it was not sure — an unclear dose, a drug it could
not place — and signing is the doctor's name on a legal document, so every
uncertain line has to have been looked at. The app greys the button out; this is
the part that cannot be got around. `details.itemIds` says which lines.

**Abandoning one.** `POST /prescriptions/:id/cancel` marks a draft
`cancelled`, which frees the one-draft-per-visit slot and is the way out of a
revision somebody thought better of. Only a draft: an approved prescription is
a document somebody is holding, and the way to withdraw it is to revise it.

**Preview** (`GET /prescriptions/:id/preview`) renders a draft through the same
template the printer uses, so what the doctor checks is what prints. It is marked
DRAFT — NOT VALID, carries no number, and builds the letterhead live because
there is no frozen snapshot yet. It is never written to the prescription's
`pdfKey`: a preview of an unsigned draft must not be able to become the approved
file. The key carries the version and the moment the draft last changed, so an
edit gives a fresh URL rather than a stale page.

**The dose in words.** Each medicine prints an English and an Urdu instruction.
When the doctor typed one it is used; otherwise `doseInstruction()` builds it
from the form, the pattern and the timing — "1 tablet in the morning and at
night, after meal". It lives in [src/shared/dose.ts](src/shared/dose.ts) because
the app shows those words while the doctor is still editing and the page prints
them an hour later; the two must not be able to disagree about what the patient
was told. It is derived from the dose and never from the transcriber, so a typed
prescription reads exactly like a dictated one.

The print file is rendered on first ask rather than at approval, so an approval
never waits on a renderer. With `PDF_RENDERER_URL` set, the HTML is posted there
and the PDF stored; without one, the HTML is stored and `meta.format` says so.

`editLog` records every typed correction and `correctedBySpeech` marks every
dictated one. Together they are how the accuracy of the voice pipeline gets
measured over real use.

## Verifying a printout

Anyone can print a page that looks like a doctor's letterhead, and anyone can
change "5 days" to "30" with a pen. So every approved printout carries a QR code
beside its Rx ID. A pharmacist scans it with any phone camera and sees, from the
server, what the doctor actually approved.

**The code.** Approving a prescription gives it a `verificationCode` in the same
write as the signature: 16 random bytes, base64url, 22 characters. It is random
rather than derived from the id or the Rx number, both of which can be guessed,
and a unique partial index holds it unique across every clinic. A superseded
prescription keeps its code; a draft or a cancelled one has none. At boot,
`backfillVerificationCodes()` gives every approved or superseded prescription from
before codes existed its own.

**The link.** The QR holds `{VERIFY_BASE_URL}/{code}` and never any patient
data. `VERIFY_BASE_URL` is the web app's public `/v` page, outside sign-in;
it is **required in production**, and in development defaults to
`http://{this machine's LAN address}:5173/v`, so a phone on the same Wi-Fi can
scan a test print. `PrescriptionView.verification` is `{ code, url }`, and null
before approval.

**Two public routes**, with no sign-in and no `X-Practice-Id`, so they sit outside
the rule every other route follows:

- `GET /verify/:code` answers `verifyViewSchema`
  ([src/shared/verify.schema.ts](src/shared/verify.schema.ts)):
  - `status`, the Rx ID and when it was approved;
  - the doctor and clinic from the letterhead snapshot, as printed;
  - the medicines;
  - a patient line: the initials of the first and last words of the name
    ("M. K."), the age as the printout showed it (from the date of birth on the
    day of approval, or the age that was typed), and sex.

  Never the name, phone or MR number, and never the diagnosis, complaints,
  history, examination, labs, diet or advice, because anyone holding the paper
  can scan it.

- `GET /verify/:code/qr.svg` is the QR image (`verifyQrPath(code)`), drawn by the
  server so neither app needs a QR library:
  - error correction M, and no quiet zone because the printout leaves its own;
  - `Cache-Control: public, max-age=31536000, immutable`;
  - cross-origin, so the web app can show it in an `<img>`.

**Replaced.** A superseded prescription answers `replaced`, with `replacedBy`
naming the approved version that stands now (the newest, through any revisions
in between), and no medicines, because the old list is no longer valid. Version
1 is only superseded when version 2 is approved, so while a revision is still a
draft the paper in the patient's hand answers `valid`.

**Giving nothing away.**

- An unknown code, a malformed one, and one on a draft or cancelled
  prescription all answer the same `NOT_FOUND`.
- Both routes share their own bucket of 30 requests a minute per address
  (`VERIFY_RATE_LIMIT_MAX`), so codes cannot be tried in bulk.
- The request log keeps only the first four characters of a code
  (`/verify/k7Q2…`).
- A read writes no audit row.

**The server's printout** puts the QR, as inline SVG, in the footer beside the
Rx ID. The draft preview stays as it was, with no QR and no Rx number. A
print file rendered before codes existed has no QR; it is rendered once and
kept, so a reprint of one of those still shows none.

## Voice

One segment of audio at a time, base64 inside the JSON body, with `seq` strictly
one more than the last: an upload that skips ahead is refused rather than quietly
reordered, because the ops of segment 3 can refer to a line segment 2 was about to
add. Transcription runs in process; the doctor's app hears `voice` on the
realtime socket when a segment is applied or fails, and reads
`GET /prescriptions/:id/voice`.

```
audio → transcript + spans → ops → server validates → server applies
```

Every line on the page keeps the `sourceSpanIds` it came from, so it can always be
traced back to what was said.

**Where the audio goes.** With `STT_PROVIDER=openai`, each recording is sent to
OpenAI to be transcribed and the transcript is sent on to be turned into ops.
The recording itself is kept in the clinic's own private storage and deleted
`AUDIO_RETENTION_DAYS` after the prescription is approved (30 by default); the
transcript stays, because it is the record of what was dictated. A clinic needs
to be able to tell a patient that, so it is stated here rather than left to be
discovered. Nothing is sent anywhere while both providers are `none`.

**The transcriber and the ops extractor are seams, and default to `none`**, which
fails a segment with a clear error. Choosing them is a decision about accuracy on
Pakistani code-switched speech and about where patient audio is allowed to go, and
it is not made here; what is settled is the contract on either side. The `mock` drivers read the upload as UTF-8 text and accept a JSON array of
ops, which is how the ordering, validation, apply and audit path is tested end
to end.

**With `openai`:** the transcriber is told it is hearing Pakistani clinical
dictation that switches language inside a sentence, and is given the drug names
already on the draft - a brand name is the word a general model gets wrong and
the word that has to be right. The extractor is called with structured output
against a JSON schema built from the shared constants, so renaming a section
changes what the model may say without anybody editing a prompt, and it is sent
the draft with its item ids so "change the Panadol to twice a day" updates that
line instead of adding a second one. It is told to use only what was said: a
medicine needs a name, and a dose or duration that was not said is left empty
and flagged rather than guessed - which means `RX_HAS_FLAGS` stops it being
approved until the doctor has looked. Speech to the patient produces no ops.

Whatever comes back is still only a proposal. `validateOps` checks every op
before a single section is touched, so an invented item id or a section that
does not exist fails that segment and leaves the draft alone. `costUsd` is
estimated from the audio minutes and the token usage against published rates,
for comparing one dictation with another - it is not a bill, and a model that
is not in the rate table reports null rather than a made-up number.

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
- **Location scope**: visits, prescriptions, voice and appointments. Patients
  belong to the practice and are linked to locations; the doctor's search and
  history are practice-wide **on purpose**, and an assistant sees the patients of
  their own locations (see **Whose patients**).
- **Bilingual** fields that print in Urdu hold `{ en, ur }`.
- **Feature flags** live on `practice.features`.
- **Naming**: collections plural camelCase, events `entity.pastTense`, permissions
  `entity.verb`.
- **Private files**: audio and PDFs in private object storage only, served by short
  signed URLs. With S3 or R2 the bucket presigns them. With the local driver the
  API signs and serves them itself at `GET /api/v1/files/<key>?expires=&sig=`,
  HMAC'd with the JWT secret — a `file://` path is no use to a phone — and takes
  uploads at `PUT` on the same path (see **Reports**). That route
  carries no session on purpose: the link is the credential, so the app can hand
  it to a WebView, an image tag or a share sheet. It answers with
  `Cross-Origin-Resource-Policy: cross-origin`, so the web app can show a page in
  an `<img>` from its own dev server. Every signed URL says its
  `contentType`, because without a renderer configured a print file is HTML and
  an app that assumes PDF will offer to share something it cannot. No patient names in logs or in object keys. The application log
  carries ids and masked phone numbers; the before/after of a record belongs in the
  audit log.

## Events

`patient.added`, `patient.updated`, `visit.added`, `visit.moved`,
`visit.statusChanged`, `vitals.recorded`, `voice.segmentApplied`,
`voice.segmentFailed`, `prescription.approved`, `prescription.revised`,
`appointment.booked`, `appointment.cancelled`, `appointment.arrived`,
`member.added`, `member.removed`, `member.locationsChanged`,
`member.roleChanged`, `location.added`, `location.updated`,
`location.archived`, `report.uploaded`, `report.reviewed`,
`notification.created`, `notification.read`, `session.revoked`.

Services emit; [src/listeners](src/listeners) decides what they cause. No service
calls notification, SMS or realtime code directly, so adding push later means
adding a handler and editing no prescription code. Some events exist only for
the realtime listener and cause no notification.

## Realtime

One WebSocket per open app, on the API's own port at `/api/v1/realtime`
(`REALTIME_PATH`). It replaces polling. The server says **that** something
changed, never what it changed to: `{ type: 'changed', topic, id? }`. The app
refetches through the ordinary routes, so permissions and who-sees-which-patient
are decided there and nowhere else, and no name, phone or medical detail ever
crosses the socket. There is no polling behind it: the app refetches everything
it shows on every connect and reconnect. The contract is
[src/shared/realtime.schema.ts](src/shared/realtime.schema.ts).

**The handshake.**

1. Connect to `wss://<api host>/api/v1/realtime`. Nothing goes in the URL; a
   token in the query string is never read.
2. Within `REALTIME_AUTH_TIMEOUT_MS` (10 s), send
   `{ type: 'auth', token, practiceId, locationId }`: the access token, and the
   ids the app sends as `X-Practice-Id` and `X-Location-Id`. Otherwise the
   server sends `UNAUTHENTICATED` and closes.
3. The server runs the checks a request to a location-scoped route gets
   (`authenticate`, `practiceContextFor`, `checkLocation`, the same functions
   the middleware calls). On success it sends `{ type: 'ready' }` and nothing
   is sent before that. On failure it sends `{ type: 'error', code, message }`
   with the code the HTTP request would have answered, then closes.
4. After every token refresh, send `auth` again on the same socket with the new
   token. It must be the same person, session, clinic and location, and it moves
   the expiry on; there is no reply. A different clinic or location is
   `VALIDATION_ERROR` and a close: open a new connection. A token that runs out
   with no fresh one is `TOKEN_EXPIRED` and a close: refresh, then reconnect.
5. `{ type: 'heartbeat' }` arrives every `REALTIME_HEARTBEAT_MS` (25 s). Fifty
   seconds of silence means the connection is dead: close it and reconnect.
   The server also pings at the protocol level and terminates a socket that
   misses two pongs.

Anything the app sends that is not a valid `auth` is ignored. A frame over 4 KB
closes the socket. A browser's `Origin` must be one `CORS_ORIGINS` allows; the
mobile app sends none and is let through, as on the HTTP API.

**Topics.** Whoever made the change hears it too: they may have the app open on
another device.

| Topic           | Sent when                                                                                               | Sent to                                                                                             | `id`           |
| --------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------- |
| `visits`        | a visit is added to the day (by hand or by starting a prescription), changes status, moves in the order | sockets on that visit's location                                                                    | visitId        |
| `vitals`        | vitals recorded                                                                                         | sockets on that visit's location                                                                    | visitId        |
| `prescriptions` | approved, revised                                                                                       | sockets on the prescription's location                                                              | prescriptionId |
| `appointments`  | booked, cancelled, or marked arrived because the patient was added to that day's list                   | sockets on the appointment's location                                                               | appointmentId  |
| `patients`      | a patient is added or edited                                                                            | doctors, and assistants at a location the patient is linked to (`canSeePatient` in patient.service) | patientId      |
| `reports`       | uploaded, reviewed (the first look only)                                                                | as `patients`, for the report's patient                                                             | reportId       |
| `notifications` | one is written to this person's inbox, or theirs are marked read on any device                          | that person, in that clinic                                                                         | none           |
| `team`          | a member is added or removed, or their locations or role change                                         | everyone in the clinic                                                                              | membershipId   |
| `locations`     | a location is added, edited or archived                                                                 | everyone in the clinic                                                                              | locationId     |
| `voice`         | a dictation segment is applied or fails                                                                 | the prescription's doctor                                                                           | prescriptionId |

A patient found by their whole phone number (the 30-minute introduction in
patient.service) does not make anyone hear about them; links do.

**Close codes.** Every close the server starts for a reason comes after an
`error` message, with WebSocket close code 1008 and the error code as the close
reason.

| `error.code`                         | When                                                                    | What the app does                       |
| ------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------- |
| `UNAUTHENTICATED`                    | no `auth` within 10 s                                                   | reconnect and send `auth` straight away |
| `TOKEN_INVALID`                      | a token that is not ours, or a later `auth` for a different sign-in     | sign out locally                        |
| `TOKEN_EXPIRED`                      | at sign-in, or when the token runs out with no fresh `auth`             | refresh, then reconnect                 |
| `SESSION_REVOKED`, `SESSION_EXPIRED` | signed out on this device or from another, or the session ended         | sign out locally                        |
| `NOT_MEMBER`, `MEMBERSHIP_REMOVED`   | not, or no longer, a member of this clinic                              | leave the clinic                        |
| `LOCATION_NOT_ALLOWED`               | not, or no longer, working at this location (locations or role changed) | choose another location                 |
| `LOCATION_ARCHIVED`                  | the location was archived                                               | choose another location                 |
| `VALIDATION_ERROR`                   | a later `auth` named a different clinic or location                     | open a new connection                   |
| `INTERNAL`                           | the checks could not run                                                | reconnect with backoff                  |

A close with no `error` before it - 1001 when the server restarts, 1006 when
the line dropped or a dead socket was terminated - means reconnect with backoff,
then refetch.

**Inside.** [src/core/realtime](src/core/realtime) holds the upgrade and the
heartbeat (`server.ts`), the handshake (`handshake.ts`), the open connections
by location, user, session and clinic (`registry.ts`), and `deliver()`
(`deliver.ts`). [src/listeners/realtime.ts](src/listeners/realtime.ts) turns
each event into a delivery. Services emit and know nothing about sockets.

**Past one process.** Today there is one process (`instances: 1` in
`ecosystem.config.json`), so the connections live in memory. Everything a
write causes goes through `deliver()`, and a delivery is plain data: ids as
strings, and an audience described rather than resolved. To run several
processes, `deliver()` publishes each delivery to a Redis channel instead,
every process subscribes and calls `deliverHere()` on its own connections, and
nothing else changes: no listener, no service, no registry. nginx can spread
sockets across processes freely, because a socket only ever talks to the
process holding it. The session cache in session.service is the other
in-process state to move at the same time.

## Deliberately not built yet

- **No queue.** Transcription, extraction and PDF rendering run in process,
  and the app hears about a finished segment over the realtime socket. A queue
  is worth adding when load asks for it, and the housekeeping sweeps in
  [src/index.ts](src/index.ts) are plain timers for the same reason.
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

| File                                                                                       | What it proves                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [tests/integration/tenancy.test.ts](tests/integration/tenancy.test.ts)                     | practice A cannot read or write practice B's patients; a PA is held to their own locations; removing them ends their access now                                                                                                                                                                   |
| [tests/integration/prescription.test.ts](tests/integration/prescription.test.ts)           | an approved prescription cannot be mutated; a revise makes v2 and supersedes v1; the letterhead stays frozen; concurrent approvals never collide on a number                                                                                                                                      |
| [tests/integration/voice.test.ts](tests/integration/voice.test.ts)                         | ops are validated by the server before they are applied; segments apply in order; audio retention deletes the recording and keeps the transcript                                                                                                                                                  |
| [tests/integration/routes.test.ts](tests/integration/routes.test.ts)                       | every route in the table responds, with real data or 501                                                                                                                                                                                                                                          |
| [tests/unit/services/prescriptionOps.test.ts](tests/unit/services/prescriptionOps.test.ts) | the ops engine, including that one bad op discards the whole batch                                                                                                                                                                                                                                |
| [tests/unit/core/permissions.test.ts](tests/unit/core/permissions.test.ts)                 | the permissions table, read straight across                                                                                                                                                                                                                                                       |
| [tests/integration/assistant.test.ts](tests/integration/assistant.test.ts)                 | the PA's day: queue tokens that never repeat or get reused, MR numbers, allergies, vitals, reports, the schedule and the inbox                                                                                                                                                                    |
| [tests/integration/queueOrder.test.ts](tests/integration/queueOrder.test.ts)               | the assistant's order of the list: a new visit goes last, a move goes before another or to the end and keeps its token, only waiting visits move, two moves at once both land, and the backfill keeps token order                                                                                 |
| [tests/integration/patientLocations.test.ts](tests/integration/patientLocations.test.ts)   | an assistant sees the patients of their own locations: search, list, counts and every by-id route, `NOT_FOUND` for the rest; links from registering, visits and appointments; the whole-phone match; a location taken away; the backfill                                                          |
| [tests/integration/files.test.ts](tests/integration/files.test.ts)                         | signed downloads and uploads: a good link serves or takes the file, a tampered or expired one is refused, an upload of the wrong type or size is refused, and a browser on an allowed origin may PUT                                                                                              |
| [tests/integration/history.test.ts](tests/integration/history.test.ts)                     | a patient's timeline: every kind in one order, paged without repeats, practice-wide, a revision's labs, the doctor's alone                                                                                                                                                                        |
| [tests/integration/templates.test.ts](tests/integration/templates.test.ts)                 | templates keep the regimen and drop the patient, belong to one doctor, and add to an open draft without removing or doubling a line                                                                                                                                                               |
| [tests/integration/prescriptionList.test.ts](tests/integration/prescriptionList.test.ts)   | the prescriptions list: who each is for, Karachi day ranges, search by name, phone or MR number, and location scope                                                                                                                                                                               |
| [tests/integration/soloDoctor.test.ts](tests/integration/soloDoctor.test.ts)               | a doctor with no assistant: the visit follows the prescription, and the patients list sorts and filters                                                                                                                                                                                           |
| [tests/integration/realtime.test.ts](tests/integration/realtime.test.ts)                   | the realtime socket: every sign-in failure gives the HTTP code and closes; a fresh token keeps it open; who hears which topic; every row of the topics table sends exactly one message; lost access closes the right sockets; no message carries a name, phone or medical field                   |
| [tests/integration/realtimeTimers.test.ts](tests/integration/realtimeTimers.test.ts)       | under fake timers: an unsigned socket is closed after 10 s, the heartbeat goes out every 25 s, and a socket that stops answering pings is terminated                                                                                                                                              |
| [tests/integration/verify.test.ts](tests/integration/verify.test.ts)                       | a printout's QR: approval makes a unique code, the backfill fills old ones, the public page answers `valid` or `replaced` with no name, phone, MR number or clinical section, every kind of miss is the same `NOT_FOUND`, the SVG decodes to the link, and the log keeps only the start of a code |
| [tests/integration/verifyRateLimit.test.ts](tests/integration/verifyRateLimit.test.ts)     | the verify routes share their own bucket of 30 a minute, and the 31st answers `RATE_LIMITED`                                                                                                                                                                                                      |
| [tests/integration/logout.test.ts](tests/integration/logout.test.ts)                       | signing out: the session goes, an unexpired token is then refused, it is idempotent, works with a lapsed token, one device does not affect another, a rotated token coming back ends the session, and no token is ever stored or audited                                                          |
| [tests/integration/dictation.test.ts](tests/integration/dictation.test.ts)                 | real dictation against a stubbed OpenAI: a clean mix of Urdu and English, an update to an existing line, speech to the patient, an invented item id, a timeout and a retry                                                                                                                        |
| [tests/unit/services/vitalFlags.test.ts](tests/unit/services/vitalFlags.test.ts)           | the normal ranges the app and the server both read                                                                                                                                                                                                                                                |
| [tests/unit/services/dose.test.ts](tests/unit/services/dose.test.ts)                       | every dose pattern, timing and form, in English and Urdu                                                                                                                                                                                                                                          |

# RxDictateApi
