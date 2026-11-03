// State: travelers, config, and the live event timeline.
// DynamoDB in Lambda (TABLE_NAME set); in-memory for local dev.
import { SEED_TRAVELERS } from './seed.mjs';

const TABLE = process.env.TABLE_NAME;
const DEFAULT_CONFIG = { threshold: 0.65, asyncDelaySec: 8, cdcMode: 'rest' }; // cdcMode: rest | s3 | both

let ddb, cmd;
async function db() {
  if (!ddb) {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const lib = await import('@aws-sdk/lib-dynamodb');
    ddb = lib.DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    cmd = lib;
  }
  return ddb;
}

const mem = { travelers: new Map(), config: null, events: [] };
const clone = (x) => JSON.parse(JSON.stringify(x));

async function get(pk, sk) {
  const r = await (await db()).send(new cmd.GetCommand({ TableName: TABLE, Key: { pk, sk } }));
  return r.Item?.data;
}
async function put(pk, sk, data, extra = {}) {
  await (await db()).send(new cmd.PutCommand({ TableName: TABLE, Item: { pk, sk, data, ...extra } }));
}

export async function listTravelers() {
  if (!TABLE) {
    if (!mem.travelers.size) await resetTravelers();
    return [...mem.travelers.values()].map(clone);
  }
  const r = await (await db()).send(new cmd.QueryCommand({
    TableName: TABLE, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'TRAVELER' },
  }));
  if (!r.Items.length) return resetTravelers();
  return r.Items.map((i) => i.data).sort((a, b) => a.contactKey.localeCompare(b.contactKey));
}

export async function getTraveler(contactKey) {
  if (!TABLE) return (await listTravelers()).find((t) => t.contactKey === contactKey);
  return (await get('TRAVELER', contactKey)) ?? (await listTravelers()).find((t) => t.contactKey === contactKey);
}

export async function saveTraveler(t) {
  if (!TABLE) return void mem.travelers.set(t.contactKey, clone(t));
  await put('TRAVELER', t.contactKey, t);
}

export async function resetTravelers() {
  for (const t of SEED_TRAVELERS) await saveTraveler({ ...clone(t), lastPrediction: null });
  return clone(SEED_TRAVELERS);
}

export async function getConfig() {
  if (!TABLE) return { ...DEFAULT_CONFIG, ...mem.config };
  return { ...DEFAULT_CONFIG, ...(await get('CONFIG', 'CONFIG')) };
}

export async function setConfig(patch) {
  const next = { ...(await getConfig()), ...patch };
  if (!TABLE) mem.config = next;
  else await put('CONFIG', 'CONFIG', next);
  return next;
}

// Timeline events: { ts, id, kind, title, contactKey?, detail }
export async function logEvent(kind, title, detail = {}, contactKey) {
  const ts = Date.now();
  const ev = { ts, id: `${ts}-${Math.random().toString(36).slice(2, 7)}`, kind, title, contactKey, detail };
  console.log('EVENT', JSON.stringify(ev));
  if (!TABLE) { mem.events.push(ev); mem.events = mem.events.slice(-500); return ev; }
  // 7-day TTL keeps the table tidy.
  await put('EVENTS', ev.id, ev, { ttl: Math.floor(ts / 1000) + 7 * 86400 });
  return ev;
}

export async function listEvents(since = 0) {
  if (!TABLE) return mem.events.filter((e) => e.ts > since);
  const r = await (await db()).send(new cmd.QueryCommand({
    TableName: TABLE, KeyConditionExpression: 'pk = :p AND sk > :s',
    ExpressionAttributeValues: { ':p': 'EVENTS', ':s': String(since) }, ScanIndexForward: false, Limit: 200,
  }));
  return r.Items.map((i) => i.data).reverse();
}
