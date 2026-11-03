// Data 360 Query API: read the zero-copy prediction DMO, which federates
// main.expedia_sat.saturation_predictions straight out of Databricks.
const LOGIN = (process.env.D360_LOGIN_URL || '').replace(/\/$/, '');
const DMO = process.env.D360_DMO || 'EXP_SaturationPrediction__dlm';
let tok = { value: null, exp: 0 };

export const d360Configured = () => Boolean(LOGIN && process.env.D360_CLIENT_ID && process.env.D360_CLIENT_SECRET);

async function token() {
  if (tok.value && Date.now() < tok.exp) return tok.value;
  const r = await fetch(`${LOGIN}/services/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.D360_CLIENT_ID, client_secret: process.env.D360_CLIENT_SECRET }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Data 360 auth ${r.status}: ${j.error_description || j.error}`);
  tok = { value: j.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return tok.value;
}

export async function readFromD360(contactKey) {
  const sql = `SELECT "EXP_Prediction__c", "EXP_SaturationScore__c", "EXP_ScoringMode__c", "EXP_ScoredAt__c" FROM "${DMO}" WHERE "EXP_ContactKey__c" = '${contactKey.replace(/'/g, "''")}'`;
  const r = await fetch(`${LOGIN}/services/data/v66.0/ssot/query-sql?dataspace=default`, {
    method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }),
  });
  const j = await r.json();
  if (!r.ok) {
    const msg = JSON.stringify(j);
    if (/does not exist/.test(msg)) throw new Error('DMO not mapped to a Databricks data stream yet');
    throw new Error(`Data 360 ${r.status}: ${msg.slice(0, 300)}`);
  }
  if (!j.data?.length) return null;
  return Object.fromEntries(j.metadata.map((c, i) => [c.name, j.data[0][i]]));
}
