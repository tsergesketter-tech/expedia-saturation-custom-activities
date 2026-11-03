import { randomUUID } from 'node:crypto';
// Marketing Cloud Engagement REST: API Event injection + Data Extension upserts.
const AUTH = (process.env.MCE_AUTH_BASE_URL || '').replace(/\/$/, '');
let tok = { value: null, exp: 0, rest: null, soap: null };

export const mceConfigured = () => Boolean(AUTH && process.env.MCE_CLIENT_ID && process.env.MCE_CLIENT_SECRET);

async function token() {
  if (tok.value && Date.now() < tok.exp) return tok;
  const body = { grant_type: 'client_credentials', client_id: process.env.MCE_CLIENT_ID, client_secret: process.env.MCE_CLIENT_SECRET };
  if (process.env.MCE_ACCOUNT_ID) body.account_id = process.env.MCE_ACCOUNT_ID;
  const r = await fetch(`${AUTH}/v2/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`MCE auth ${r.status}: ${JSON.stringify(j)}`);
  tok = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000, rest: j.rest_instance_url.replace(/\/$/, ''), soap: j.soap_instance_url.replace(/\/$/, '') };
  return tok;
}

async function call(method, path, body) {
  const t = await token();
  const r = await fetch(`${t.rest}${path}`, {
    method, headers: { Authorization: `Bearer ${t.value}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) throw new Error(`MCE ${method} ${path} ${r.status}: ${text.slice(0, 500)}`);
  return json;
}

// Fire the journey's API Event entry source for one traveler.
export function injectToJourney(traveler, eventKey = process.env.MCE_EVENT_DEFINITION_KEY) {
  const f = traveler.features;
  return call('POST', '/interaction/v1/events', {
    ContactKey: traveler.contactKey,
    EventDefinitionKey: eventKey,
    Data: {
      EntryId: randomUUID(),
      SubscriberKey: traveler.contactKey,
      EmailAddress: traveler.email,
      FirstName: traveler.firstName,
      LastName: traveler.lastName,
      OneKeyTier: traveler.tier,
      HomeAirport: traveler.homeAirport,
      Sends7d: f.sends7d,
      Sends30d: f.sends30d,
      OpenRate30d: f.openRate30d,
      ClickRate30d: f.clickRate30d,
      DaysSinceLastEngaged: f.daysSinceLastEngaged,
      DaysToNextTrip: f.daysToNextTrip ?? '',
      EntryTimestamp: new Date().toISOString(),
    },
  });
}

export const predictionRow = (p, mode, ctx = {}) => ({
  SubscriberKey: p.contactKey,
  SaturationScore: p.saturationScore,
  Prediction: p.prediction,
  ReasonCodes: p.reasonCodes.join('|'),
  RecommendedHoldHours: p.recommendedHoldHours,
  ModelVersion: p.modelVersion,
  ScoringMode: mode,
  ScoredAt: p.scoredAt,
  JourneyId: ctx.journeyId || '',
  ActivityId: ctx.activityId || '',
});

// CDC push: upsert the latest prediction into the predictions DE (keyed on SubscriberKey).
export function upsertPredictions(rows) {
  const key = process.env.MCE_PREDICTIONS_DE_KEY || 'Expedia_Saturation_Predictions';
  return call('POST', `/hub/v1/dataevents/key:${encodeURIComponent(key)}/rowset`,
    rows.map(({ SubscriberKey, ...values }) => ({ keys: { SubscriberKey }, values })));
}

// Read one traveler's current row from the predictions DE.
export async function readPrediction(contactKey) {
  const key = process.env.MCE_PREDICTIONS_DE_KEY || 'Expedia_Saturation_Predictions';
  const filter = encodeURIComponent(`SubscriberKey eq '${contactKey.replace(/'/g, "''")}'`);
  const r = await call('GET', `/data/v1/customobjectdata/key/${encodeURIComponent(key)}/rowset?$filter=${filter}`);
  const item = r.items?.[0];
  return item ? { ...item.keys, ...item.values } : null;
}

// Read every row in the predictions DE (demo-sized).
export async function readAllPredictions() {
  const key = process.env.MCE_PREDICTIONS_DE_KEY || 'Expedia_Saturation_Predictions';
  const r = await call('GET', `/data/v1/customobjectdata/key/${encodeURIComponent(key)}/rowset?$pageSize=200`);
  return (r.items || []).map((item) => ({ ...item.keys, ...item.values }));
}

// Kick the S3 → DE import automation (Automation Studio) on demand.
export async function runAutomation(customerKey) {
  const t = await token();
  const soapUrl = `${t.soap}/Service.asmx`;
  const env = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><s:Header><a:Action s:mustUnderstand="1">Perform</a:Action><a:To s:mustUnderstand="1">${soapUrl}</a:To><fueloauth xmlns="http://exacttarget.com">${t.value}</fueloauth></s:Header><s:Body><PerformRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI"><Action>start</Action><Definitions><Definition xsi:type="Automation"><CustomerKey>${customerKey}</CustomerKey></Definition></Definitions></PerformRequestMsg></s:Body></s:Envelope>`;
  const r = await fetch(soapUrl, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: env });
  const xml = await r.text();
  const status = xml.match(/<StatusCode>(\w+)<\/StatusCode>/)?.[1];
  if (status !== 'OK') throw new Error(`Automation start failed: ${(xml.match(/<StatusMessage>(.*?)<\/StatusMessage>/) || [])[1] || xml.slice(0, 300)}`);
  return { automation: customerKey, status };
}
