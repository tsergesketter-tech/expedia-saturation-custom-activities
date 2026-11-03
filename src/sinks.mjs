// Prediction sinks outside MCE: S3 CSV drops (MCE batch import) and Databricks Delta (D360 zero copy).

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows) => {
  const cols = Object.keys(rows[0]);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
};

// Drops CSVs to the MCE S3 file location: a timestamped archive of this batch, plus
// saturation_predictions_latest.csv (full snapshot) that the MCE Import activity loads.
export async function dropToS3(rows, label, snapshotRows = rows) {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET not configured');
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({});
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const archive = `mce-inbound/archive/saturation_predictions_${label}_${ts}.csv`;
  const latest = 'mce-inbound/saturation_predictions_latest.csv';
  await Promise.all([
    s3.send(new PutObjectCommand({ Bucket: bucket, Key: archive, Body: toCsv(rows), ContentType: 'text/csv' })),
    s3.send(new PutObjectCommand({ Bucket: bucket, Key: latest, Body: toCsv(snapshotRows), ContentType: 'text/csv' })),
  ]);
  return { bucket, archive, latest, snapshotRows: snapshotRows.length };
}

// Databricks SQL Statement Execution API. Table is the zero-copy source for D360.
const DBX_TABLE = process.env.DBX_TABLE || 'main.expedia_sat.saturation_predictions';
export const dbxConfigured = () => Boolean(process.env.DBX_HOST && process.env.DBX_TOKEN && process.env.DBX_WAREHOUSE_ID);

const sqlStr = (v) => (v == null || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

export async function writeToDatabricks(rows) {
  const values = rows.map((r) => `(${[
    sqlStr(r.SubscriberKey), Number(r.SaturationScore), sqlStr(r.Prediction), sqlStr(r.ReasonCodes),
    Number(r.RecommendedHoldHours), sqlStr(r.ModelVersion), sqlStr(r.ScoringMode), `TIMESTAMP ${sqlStr(r.ScoredAt)}`,
  ].join(', ')})`).join(',\n');
  const src = `SELECT * FROM VALUES ${values} AS s(contact_key, saturation_score, prediction, reason_codes, recommended_hold_hours, model_version, scoring_mode, scored_at)`;
  // Current-state table (what D360 federates) + append-only history.
  const statements = [
    `MERGE INTO ${DBX_TABLE} t USING (${src}) s ON t.contact_key = s.contact_key
     WHEN MATCHED THEN UPDATE SET * WHEN NOT MATCHED THEN INSERT *`,
    `INSERT INTO ${DBX_TABLE}_history ${src}`,
  ];
  const out = [];
  for (const statement of statements) { const { statementId, state, attempts } = await runStatement(statement); out.push({ statementId, state, attempts }); }
  return { table: DBX_TABLE, rows: rows.length, statements: out };
}

export async function readFromDatabricks(contactKey) {
  const r = await runStatement(`SELECT * FROM ${DBX_TABLE} WHERE contact_key = ${sqlStr(contactKey)}`);
  if (!r.columns || !r.rows.length) return null;
  return Object.fromEntries(r.columns.map((c, i) => [c, r.rows[0][i]]));
}

// Concurrent sync/async/batch writes can conflict on the same Delta table; retry those.
async function runStatement(statement, attempt = 1) {
  const r = await fetch(`https://${process.env.DBX_HOST}/api/2.0/sql/statements`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.DBX_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ warehouse_id: process.env.DBX_WAREHOUSE_ID, statement, wait_timeout: '30s' }),
  });
  const j = await r.json();
  const err = !r.ok || j.error_code || j.status?.state === 'FAILED' ? JSON.stringify(j.status?.error || j) : null;
  if (err && /CONCURRENT|ConcurrentAppend|Transaction conflict/i.test(err) && attempt < 5) {
    await new Promise((res) => setTimeout(res, 500 * attempt + Math.random() * 1000));
    return runStatement(statement, attempt + 1);
  }
  if (err) throw new Error(`Databricks ${r.status}: ${err.slice(0, 400)}`);
  return { statementId: j.statement_id, state: j.status?.state, attempts: attempt, columns: j.manifest?.schema?.columns?.map((c) => c.name), rows: j.result?.data_array };
}
