// Lambda (API Gateway) entry point: demo console API, MCE custom activity endpoints,
// stub saturation model, and background CDC/Databricks jobs.
// PROTOTYPE for illustration only: not production-hardened or scale-tested.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { score, MODEL_VERSION } from './model.mjs';
import * as store from './store.mjs';
import { decodeJwt } from './jwt.mjs';
import { injectToJourney, upsertPredictions, predictionRow, mceConfigured, runAutomation, readPrediction, readAllPredictions } from './mce.mjs';
import { dropToS3, writeToDatabricks, readFromDatabricks, dbxConfigured } from './sinks.mjs';
import { activityConfig } from './activities.mjs';
import { readFromD360, d360Configured } from './d360.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export async function handler(event) {
  if (event.job) return runJob(event); // async self-invocation
  const method = event.requestContext?.http?.method || 'GET';
  const route = event.rawPath || '/';
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  const baseUrl = `https://${event.headers?.host}`;
  try {
    return await routeRequest(method, route, raw, event, baseUrl);
  } catch (err) {
    console.error(err);
    await store.logEvent('error', `${method} ${route} failed`, { message: err.message });
    return json(500, { error: err.message });
  }
}

async function routeRequest(method, route, raw, event, baseUrl) {
  const body = () => (raw ? JSON.parse(raw) : {});

  // ---- MCE custom activities -------------------------------------------------
  let m = route.match(/^\/ca\/(sync|async)\/config\.json$/);
  if (m) return json(200, activityConfig(m[1], baseUrl));

  m = route.match(/^\/ca\/(sync|async)\/(execute|save|validate|publish|stop)$/);
  if (m && method === 'POST') return activityCall(m[1], m[2], raw);

  // ---- Demo console API -----------------------------------------------------
  if (route === '/api/state' && method === 'GET') {
    return json(200, {
      travelers: await store.listTravelers(), config: await store.getConfig(), modelVersion: MODEL_VERSION,
      integrations: { mceImport: Boolean(process.env.MCE_IMPORT_AUTOMATION_KEY), mce: mceConfigured(), databricks: dbxConfigured(), d360: d360Configured(), s3: Boolean(process.env.S3_BUCKET), jwtVerify: Boolean(process.env.MCE_JWT_SECRET) },
      activityUrls: { sync: `${baseUrl}/ca/sync/`, async: `${baseUrl}/ca/async/` },
    });
  }
  if (route === '/api/events' && method === 'GET') {
    return json(200, await store.listEvents(Number(event.queryStringParameters?.since || 0)));
  }
  if (route === '/api/config' && method === 'POST') {
    const cfg = await store.setConfig(body());
    await store.logEvent('ui', 'Model config updated', cfg);
    return json(200, cfg);
  }
  if (route === '/api/reset' && method === 'POST') {
    await store.resetTravelers();
    await store.logEvent('ui', 'Travelers reset to seed state');
    return json(200, { ok: true });
  }
  m = route.match(/^\/api\/travelers\/([^/]+)\/landed$/);
  if (m && method === 'GET') return json(200, await landed(decodeURIComponent(m[1])));
  m = route.match(/^\/api\/travelers\/([^/]+)\/(adjust|score|inject)$/);
  if (m && method === 'POST') return travelerAction(decodeURIComponent(m[1]), m[2], body());
  m = route.match(/^\/api\/travelers\/([^/]+)\/event$/);
  if (m && method === 'POST') return eventToDe([decodeURIComponent(m[1])], body());
  if (route === '/api/de-rows' && method === 'GET') {
    const t0 = Date.now();
    return json(200, { rows: await readAllPredictions(), ms: Date.now() - t0 });
  }
  if (route === '/api/event-all' && method === 'POST') return eventToDe(null, body());
  if (route === '/api/batch' && method === 'POST') return runBatch(body());
  if (route === '/api/mce-import' && method === 'POST') {
    if (!process.env.MCE_IMPORT_AUTOMATION_KEY) return json(400, { error: 'MCE S3 import automation not configured yet' });
    const r = await guarded('cdc.s3', 'MCE automation started: S3 → Predictions DE import', () => runAutomation(process.env.MCE_IMPORT_AUTOMATION_KEY));
    return json(r.error ? 502 : 200, r);
  }

  // ---- Static ---------------------------------------------------------------
  if (method === 'GET') return serveStatic(route);
  return json(404, { error: 'not found' });
}

async function serveStatic(route) {
  let rel = route.endsWith('/') ? `${route}index.html` : route;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return json(403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const text = type.startsWith('text') || type.includes('json') || type.includes('svg');
    return { statusCode: 200, headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' }, body: text ? data.toString('utf8') : data.toString('base64'), isBase64Encoded: !text };
  } catch {
    return json(404, { error: 'not found' });
  }
}

// ---- Model access -----------------------------------------------------------

// Contacts the demo doesn't know get a stable synthetic feature vector, so real
// journey contacts still produce believable predictions.
function syntheticTraveler(contactKey) {
  const h = createHash('sha256').update(contactKey).digest();
  return {
    contactKey, firstName: 'Traveler', lastName: contactKey.slice(-4), tier: ['Blue', 'Silver', 'Gold', 'Platinum'][h[0] % 4],
    features: { sends7d: h[1] % 8, sends30d: 4 + (h[2] % 22), openRate30d: (h[3] % 50) / 100, clickRate30d: (h[4] % 10) / 100, daysSinceLastEngaged: h[5] % 60, unsubPageViews30d: h[6] % 3 === 0 ? 1 : 0, daysToNextTrip: h[7] % 3 === 0 ? 5 + (h[8] % 40) : null },
    synthetic: true,
  };
}

async function predict(contactKey, mode, overrides = {}) {
  const traveler = (await store.getTraveler(contactKey)) || syntheticTraveler(contactKey);
  const cfg = await store.getConfig();
  const p = score(traveler, { threshold: overrides.threshold ?? cfg.threshold });
  if (!traveler.synthetic) {
    traveler.lastPrediction = { ...p, mode };
    traveler.predictions = { ...(traveler.predictions || {}), [mode]: { ...p, mode } };
    await store.saveTraveler(traveler);
  }
  return { traveler, p, cfg };
}

// ---- Custom activity handlers -----------------------------------------------

function parseActivityBody(raw) {
  const s = raw.trim();
  if (s.startsWith('{')) return { payload: JSON.parse(s), verified: false };
  return decodeJwt(s, process.env.MCE_JWT_SECRET);
}

function flattenInArgs(payload) {
  return Object.assign({}, ...(payload.inArguments || payload.arguments?.execute?.inArguments || []));
}

async function activityCall(kind, op, raw) {
  const label = kind === 'sync' ? 'Saturation Check (Sync)' : 'Saturation Score Request (Async)';
  let parsed;
  try {
    parsed = parseActivityBody(raw);
  } catch (err) {
    await store.logEvent('error', `${label} /${op} rejected: ${err.message}`);
    return json(401, { error: err.message });
  }
  const { payload, verified } = parsed;

  if (op !== 'execute') {
    await store.logEvent('mce.lifecycle', `${label} /${op}`, { verified, activityObjectID: payload.activityObjectID, interactionId: payload.interactionId });
    return json(200, { success: true });
  }

  const args = flattenInArgs(payload);
  const contactKey = args.contactKey || payload.keyValue;
  const ctx = { journeyId: payload.journeyId, activityId: payload.activityId, definitionInstanceId: payload.definitionInstanceId, activityInstanceId: payload.activityInstanceId };
  const t0 = Date.now();

  // Sync callout for the contact-data journey: score in-line and write the DE before replying,
  // so the decision split right after this activity reads a fresh Contact Data row.
  if (args.mode === 'callout') {
    const { p } = await predict(contactKey, 'callout');
    const row = predictionRow(p, 'callout', ctx);
    await upsertPredictions([row]);
    const response = { branchResult: 'written', status: 'written', prediction: p.prediction, saturationScore: p.saturationScore };
    await store.logEvent('mce.callout', `MCE → model (sync callout): ${p.prediction.toUpperCase()} written to contact data in ${Date.now() - t0} ms`, { latencyMs: Date.now() - t0, verified, request: { inArguments: args, ...ctx }, response, row }, contactKey);
    await enqueue({ job: 'persist', rows: [row], cdcMode: 'none' });
    return json(200, response);
  }

  if (kind === 'sync') {
    const threshold = args.threshold ? Number(args.threshold) : undefined;
    const { p } = await predict(contactKey, 'sync', { threshold });
    const response = { branchResult: p.prediction, prediction: p.prediction, saturationScore: p.saturationScore, reasonCodes: p.reasonCodes.join('|'), modelVersion: p.modelVersion };
    await store.logEvent('mce.sync', `MCE → model (sync): ${p.prediction.toUpperCase()} in ${Date.now() - t0} ms`, { latencyMs: Date.now() - t0, verified, request: { inArguments: args, ...ctx }, response, prediction: p }, contactKey);
    // Persist to the predictions DE + Databricks without slowing the journey down.
    await enqueue({ job: 'persist', rows: [predictionRow(p, 'sync', ctx)], cdcMode: 'rest' });
    return json(200, response);
  }

  // Async: acknowledge immediately; the model calls back later.
  const cfg = await store.getConfig();
  const delaySec = Number(args.delaySec ?? cfg.asyncDelaySec);
  const cdcMode = args.cdcMode || cfg.cdcMode;
  await store.logEvent('mce.async', `MCE → model (fire-and-forget): accepted in ${Date.now() - t0} ms`, { latencyMs: Date.now() - t0, delaySec, cdcMode, verified, request: { inArguments: args, ...ctx }, response: { status: 'accepted' }, callbackIn: `${delaySec}s via ${cdcMode}` }, contactKey);
  await enqueue({ job: 'async-score', contactKey, ctx, delaySec, cdcMode });
  return json(200, { status: 'accepted' });
}

// ---- Console actions ------------------------------------------------------------

async function travelerAction(contactKey, action, body) {
  const t = await store.getTraveler(contactKey);
  if (!t) return json(404, { error: 'unknown traveler' });

  if (action === 'adjust') {
    for (const [k, v] of Object.entries(body)) if (k in t.features) t.features[k] = v;
    await store.saveTraveler(t);
    await store.logEvent('ui', `Features updated for ${t.firstName}`, body, contactKey);
    return json(200, t);
  }
  if (action === 'score') {
    const { p } = await predict(contactKey, 'console');
    await store.logEvent('model.score', `Console score: ${p.prediction.toUpperCase()} (${p.saturationScore})`, p, contactKey);
    return json(200, p);
  }
  // inject
  if (!mceConfigured() || !process.env.MCE_EVENT_DEFINITION_KEY) return json(400, { error: 'MCE event definition not configured yet' });
  const eventDefinitionKey = body.journey === 'contactdata' ? process.env.MCE_EVENT_DEFINITION_KEY_CD : process.env.MCE_EVENT_DEFINITION_KEY;
  const r = await injectToJourney(t, eventDefinitionKey);
  await store.logEvent('journey.inject', `${t.firstName} sent into journey`, { eventInstanceId: r.eventInstanceId, eventDefinitionKey, journey: body.journey || 'sync-async' }, contactKey);
  return json(200, r);
}

// Model → DE eventing: no journey, no custom activity. Apply the change, rescore, upsert the DE row,
// and read it back from MCE to prove it landed.
async function eventToDe(keys, { features, threshold } = {}) {
  if (!mceConfigured()) return json(400, { error: 'Marketing Cloud not configured' });
  if (threshold != null) await store.setConfig({ threshold: Number(threshold) });
  keys ||= (await store.listTravelers()).map((t) => t.contactKey);
  if (features && keys.length === 1) {
    const t = await store.getTraveler(keys[0]);
    if (!t) return json(404, { error: 'unknown traveler' });
    for (const [k, v] of Object.entries(features)) if (k in t.features) t.features[k] = v;
    await store.saveTraveler(t);
  }
  const t0 = Date.now();
  const rows = [];
  for (const k of keys) rows.push(predictionRow((await predict(k, 'event')).p, 'event'));
  await upsertPredictions(rows);
  const upsertMs = Date.now() - t0;
  const readBack = keys.length === 1 ? await readPrediction(keys[0]) : null;
  const what = keys.length === 1 ? `${rows[0].Prediction.toUpperCase()} (${rows[0].SaturationScore})` : `${rows.length} travelers`;
  await store.logEvent('model.event', `Model evented ${what} to the DE in ${upsertMs} ms`, { upsertMs, rows, threshold }, keys.length === 1 ? keys[0] : undefined);
  await enqueue({ job: 'persist', rows, cdcMode: 'none' });
  return json(200, { rows, upsertMs, readBack });
}

async function runBatch({ sinks = ['databricks'] } = {}) {
  const travelers = await store.listTravelers();
  const rows = [];
  for (const t of travelers) rows.push(predictionRow((await predict(t.contactKey, 'batch')).p, 'batch'));
  const results = {};
  if (sinks.includes('databricks') && dbxConfigured()) results.databricks = await guarded('dbx.write', 'Batch → Databricks', () => writeToDatabricks(rows));
  if (sinks.includes('s3') && process.env.S3_BUCKET) results.s3 = await guarded('cdc.s3', 'Batch → S3 drop for MCE import', async () => dropToS3(rows, 'batch', await snapshot(rows)));
  await store.logEvent('model.batch', `Batch scored ${rows.length} travelers`, { send: rows.filter((r) => r.Prediction === 'send').length, abstain: rows.filter((r) => r.Prediction === 'abstain').length, results });
  return json(200, { rows, results });
}

// Full current-state snapshot for the S3 "latest" file: every traveler's last prediction, overlaid with new rows.
async function snapshot(rows) {
  const byKey = new Map();
  for (const t of await store.listTravelers()) {
    if (t.lastPrediction) byKey.set(t.contactKey, predictionRow(t.lastPrediction, t.lastPrediction.mode));
  }
  for (const r of rows) byKey.set(r.SubscriberKey, r);
  return [...byKey.values()];
}

// Read the prediction back from where it landed, to prove the round trip.
async function landed(contactKey) {
  const timed = async (fn) => {
    const t0 = Date.now();
    try { return { row: await fn(), ms: Date.now() - t0 }; } catch (err) { return { error: err.message, ms: Date.now() - t0 }; }
  };
  const [mce, databricks, d360] = await Promise.all([
    mceConfigured() ? timed(() => readPrediction(contactKey)) : null,
    dbxConfigured() ? timed(() => readFromDatabricks(contactKey)) : null,
    d360Configured() ? timed(() => readFromD360(contactKey)) : null,
  ]);
  return { mce, databricks, d360 };
}

async function guarded(kind, title, fn, contactKey) {
  try {
    const r = await fn();
    await store.logEvent(kind, title, r, contactKey);
    return r;
  } catch (err) {
    await store.logEvent('error', `${title} failed`, { message: err.message }, contactKey);
    return { error: err.message };
  }
}

// ---- Background jobs ------------------------------------------------------------

async function enqueue(job) {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) { setTimeout(() => runJob(job), 0); return; }
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  await new LambdaClient({}).send(new InvokeCommand({ FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME, InvocationType: 'Event', Payload: JSON.stringify(job) }));
}

async function runJob(job) {
  if (job.job === 'async-score') {
    await new Promise((r) => setTimeout(r, Math.min(job.delaySec, 45) * 1000));
    const { p } = await predict(job.contactKey, 'async');
    await store.logEvent('model.score', `Model finished async score: ${p.prediction.toUpperCase()} (${p.saturationScore})`, p, job.contactKey);
    return persist([predictionRow(p, 'async', job.ctx)], job.cdcMode, job.contactKey);
  }
  if (job.job === 'persist') return persist(job.rows, job.cdcMode, job.rows[0]?.SubscriberKey);
}

async function persist(rows, cdcMode, contactKey) {
  const scoringMode = rows[0].ScoringMode;
  const via = scoringMode === 'async' ? 'Model pushed prediction back to MCE' : `${scoringMode} prediction saved to MCE`;
  const tasks = [];
  if ((cdcMode === 'rest' || cdcMode === 'both') && mceConfigured()) {
    tasks.push(guarded('cdc.rest', `${via} (REST upsert)`, async () => ({ scoringMode, upserted: await upsertPredictions(rows) }), contactKey));
  }
  if ((cdcMode === 's3' || cdcMode === 'both') && process.env.S3_BUCKET) {
    tasks.push(guarded('cdc.s3', `${via} (S3 file for MCE import)`, async () => ({ scoringMode, ...(await dropToS3(rows, scoringMode, await snapshot(rows))) }), contactKey));
  }
  if (dbxConfigured()) tasks.push(guarded('dbx.write', 'Prediction written to Databricks', async () => ({ scoringMode, ...(await writeToDatabricks(rows)) }), contactKey));
  await Promise.all(tasks);
}
