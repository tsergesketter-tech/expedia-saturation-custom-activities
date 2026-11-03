# Expedia Saturation Model: Journey Builder Custom Activities

This is a reference implementation of Marketing Cloud Engagement **Journey Builder custom
activities** that call an external ML model, a stub "send-saturation" model that decides
**send vs. abstain** for each contact. It comes with a live demo console and model-to-MCE
write-back over REST, S3 import, Databricks, and Data 360 zero copy.

📘 **[User Guide: building custom activities and the API contract](docs/USER_GUIDE.md)**
📐 **[JSON Schemas for the request and responses](docs/schemas/)**

![console](deck/console.png)

## What's inside

| Path | What it is |
|---|---|
| `src/activities.mjs` | Renders `config.json` for the **sync** (`RESTDECISION` split) and **async** (`REST`) activities |
| `src/handler.mjs` | Lambda entry: `/ca/{sync,async}/{execute,save,validate,publish,stop}`, console API, background jobs |
| `src/jwt.mjs` | HS256 verification of Journey Builder's signed requests |
| `src/model.mjs` | Stub saturation model: score, prediction, reason codes, hold hours |
| `src/mce.mjs` | MCE REST: API Event injection, DE rowset upsert/read, automation start |
| `src/sinks.mjs`, `src/d360.mjs` | S3 CSV drops, Databricks Delta MERGE, Data 360 query read-back |
| `src/public/ca/` | Activity config UIs (Postmonger) |
| `src/public/` | Demo console (`index.html`) and eventing console (`event.html`) |
| `deploy/` | AWS deploy (`deploy.sh`), MCE DE setup, journeys via the Interaction API, Databricks DDL |
| `deck/` | Single-file HTML session deck (`build.py` inlines the images) |
| `dev.mjs` | Local server, no AWS required |

## Quick start (local)

```bash
node dev.mjs        # http://localhost:8787  (Node 22+, in-memory store)
curl -s -XPOST localhost:8787/ca/sync/execute \
  -d '{"inArguments":[{"contactKey":"EXP-100231"}]}'
```

## Deploy

1. Copy `.env.example` to `~/expedia-mce.env` and fill it in. Put a Databricks PAT in `~/.expedia-sat/dbx_pat`.
2. `aws login` (or set credentials), then run `deploy/deploy.sh`. It prints the public URL.
3. `python3 deploy/mce_setup.py des` creates the folder and Data Extensions.
4. In MCE, add Journey Builder Activity components pointing at `https://<url>/ca/sync/` and `/ca/async/`.
5. `python3 deploy/journey.py` and `python3 deploy/journey_cd.py` build the demo journeys.

No secrets are committed. Everything sensitive is read from `~/expedia-mce.env`,
`~/.expedia-sat/`, or the local Claude MCP config at deploy time.

> The model is a deterministic stub that produces realistic-looking outputs. Replace
> `src/model.mjs#score` with a call to your real endpoint.
