// Expedia saturation model demo console.
const $ = (s, el = document) => el.querySelector(s);
const state = { travelers: [], config: {}, integrations: {}, events: [], since: 0, focus: null, landed: {} };

const REASONS = {
  HIGH_SEND_VOLUME_7D: 'many sends this week',
  HIGH_SEND_VOLUME_30D: 'heavy send volume this month',
  DECLINING_OPEN_RATE: 'low open rate',
  LOW_CLICK_THROUGH: 'few clicks',
  DAYS_SINCE_ENGAGEMENT: 'no recent engagement',
  UNSUBSCRIBE_INTENT: 'visited the unsubscribe page',
  UPCOMING_TRIP_RELEVANCE: 'upcoming trip makes messages relevant',
};
const reasonText = (code) => REASONS[code] || code.replace(/^ONE_KEY_(\w+)_TOLERANCE$/, (_, t) => `${t[0]}${t.slice(1).toLowerCase()} tier tolerates more messages`);
const MODE_LABEL = { callout: 'Journey sync callout', event: 'Model eventing', sync: 'Journey sync split', async: 'Journey async request', batch: 'Batch scoring', console: 'Console score' };

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.className = 'toast'), 3200);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x) => `${Math.round(x * 100)}%`;
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const secs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`);
const initials = (t) => t.firstName[0] + t.lastName.replace(/[^A-Za-z]/g, '')[0];
const current = () => state.travelers.find((t) => t.contactKey === state.focus);
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------- header + traveler picker ----------
function renderConnections() {
  const i = state.integrations;
  const items = [['Marketing Cloud', i.mce], ['Databricks', i.databricks], ['Data 360', i.d360], ['Amazon S3', i.s3], ['Signed requests', i.jwtVerify]];
  $('#connections').innerHTML = items.map(([n, on]) => `<span class="${on ? 'on' : ''}" title="${on ? 'Connected' : 'Not configured'}"><i></i>${n}</span>`).join('');
}

function renderTabs() {
  $('#tabs').innerHTML = state.travelers.map((t) => `
    <button class="tab" role="tab" aria-selected="${t.contactKey === state.focus}" data-key="${esc(t.contactKey)}">
      <span class="avatar tier-${esc(t.tier)}" aria-hidden="true">${esc(initials(t))}</span>${esc(t.firstName)}
    </button>`).join('');
}

function renderWidget() {
  const t = current();
  if (!t) return;
  const f = t.features;
  $('#widget').innerHTML = `
    <div class="pillbar">
      <div><b>${esc(t.firstName)} ${esc(t.lastName)}</b><small>${esc(t.tier)} member, flies from ${esc(t.homeAirport)}</small></div>
      <div><b>${f.sends7d} ${f.sends7d === 1 ? 'email' : 'emails'} this week</b><small>${f.sends30d} in the last 30 days</small></div>
      <div><b>Opens ${pct(f.openRate30d)}, clicks ${pct(f.clickRate30d)}</b><small>${f.daysSinceLastEngaged === 0 ? 'Engaged today' : `Last engaged ${f.daysSinceLastEngaged} days ago`}${f.daysToNextTrip != null ? `, trip in ${f.daysToNextTrip} days` : ''}</small></div>
      <button class="btn" data-act="inject">Send into journey</button>
    </div>
    <div class="simulate">
      <span>Change ${esc(t.firstName)}'s activity:</span>
      <button class="btn outline small" data-act="fatigue">Add 2 marketing emails</button>
      <button class="btn outline small" data-act="engage">Opened and clicked an email</button>
      <button class="btn text" data-act="score">Score without the journey</button>
      <button class="btn outline small" data-act="injectcd">Send into the contact data journey</button>
    </div>`;
}

function renderVerdict() {
  const t = current();
  const p = t?.lastPrediction;
  if (!t) return;
  if (!p) {
    $('#verdict').innerHTML = `<div class="banner none"><h2>${esc(t.firstName)} hasn't been scored yet</h2><p>Send ${esc(t.firstName)} into the journey and Marketing Cloud will ask the model.</p></div>`;
    return;
  }
  const headline = p.prediction === 'send'
    ? `Send: ${esc(t.firstName)} can take another message`
    : `Abstain: hold ${esc(t.firstName)} for ${p.recommendedHoldHours} hours`;
  const why = p.reasonCodes.length ? `Because of ${p.reasonCodes.map(reasonText).join(', ')}.` : 'No saturation signals.';
  $('#verdict').innerHTML = `
    <div class="banner">
      <span class="score ${p.prediction}" aria-label="Saturation score ${p.saturationScore}">${p.saturationScore.toFixed(2)}</span>
      <h2>${headline}</h2>
      <p>${why} Threshold ${Number(p.threshold).toFixed(2)}, from ${esc(MODE_LABEL[p.mode] || p.mode).toLowerCase()} at ${clock(p.scoredAt)}.</p>
    </div>`;
}

// ---------- the trace: one traveler's latest run through the journey ----------
function currentRun(key) {
  const evs = state.events.filter((e) => e.contactKey === key);
  const i = evs.map((e) => e.kind).lastIndexOf('journey.inject');
  return i >= 0 ? evs.slice(i) : [];
}

function payload(label, obj) {
  return `<details><summary>${label}</summary><pre>${esc(JSON.stringify(obj, null, 2))}</pre></details>`;
}

function buildSteps(run) {
  const t0 = run[0].ts;
  const at = (e) => `${clock(e.ts)}<br>+${secs(e.ts - t0)}`;
  const find = (fn, after = 0) => run.find((e) => e.ts >= after && fn(e));
  const sync = find((e) => e.kind === 'mce.sync');
  const asyncEv = find((e) => e.kind === 'mce.async');
  const scored = asyncEv && find((e) => e.kind === 'model.score', asyncEv.ts);
  const pushed = scored && find((e) => (e.kind === 'cdc.rest' || e.kind === 'cdc.s3') && e.detail?.scoringMode === 'async', scored.ts);
  const failed = find((e) => e.kind === 'error');
  const name = current().firstName;
  const steps = [];
  const step = (status, title, what = '', when = '', extra = '', cls = '') => steps.push({ status, title, what, when, extra, cls });

  step('done', `${name} entered the journey`, `API event fired into <b>Expedia Saturation-Aware Trip Inspiration</b>`, at(run[0]),
    payload('Show event', run[0].detail));

  if (sync) {
    const r = sync.detail.response;
    step('done', 'Marketing Cloud asked the model and waited',
      `Saturation Check replied <b>${r.prediction === 'send' ? 'Send' : 'Abstain'}</b> (score ${r.saturationScore}) in <b>${secs(sync.detail.latencyMs ?? 0)}</b>${sync.detail.verified ? ', signed request verified' : ''}`,
      at(sync), payload('Show request and response', { request: sync.detail.request, response: r }), 'from-mce');
    step('done', r.prediction === 'send' ? 'Routed down the Send path' : 'Routed down the Abstain path',
      r.prediction === 'send' ? 'This is where the trip-inspiration email goes' : `No email, ${name} is held while saturated`);
  } else {
    step('active', 'Waiting for Marketing Cloud to reach Saturation Check', 'Journey Builder usually takes 5 to 30 seconds to pick up a new entry');
  }

  if (asyncEv) {
    step('done', 'Marketing Cloud sent a fire-and-forget request',
      `Model acknowledged in <b>${secs(asyncEv.detail.latencyMs ?? 0)}</b> and the journey moved on without waiting`, at(asyncEv),
      payload('Show request', asyncEv.detail.request), 'from-mce');
  } else {
    step(sync ? 'active' : 'wait', 'Marketing Cloud sends a fire-and-forget request');
  }

  if (scored) {
    step('done', 'Model finished scoring in the background',
      `New score <b>${scored.detail.saturationScore}</b>, <b>${scored.detail.prediction === 'send' ? 'Send' : 'Abstain'}</b>, ${secs(scored.ts - asyncEv.ts)} after the request`, at(scored));
  } else {
    const delay = asyncEv?.detail.delaySec;
    step(asyncEv ? 'active' : 'wait', 'Model scores in the background', asyncEv ? `Simulated model time is ${delay}s` : '');
  }

  if (pushed) {
    const viaS3 = pushed.kind === 'cdc.s3';
    step('done', viaS3 ? 'Model dropped the prediction in S3 for Marketing Cloud' : 'Model pushed the prediction back to Marketing Cloud',
      viaS3 ? `Wrote <b>${esc(pushed.detail.latest)}</b>. Marketing Cloud loads it when the import automation runs.`
        : 'REST upsert into the <b>Expedia_Saturation_Predictions</b> data extension, the table Contact Builder exposes as contact data',
      at(pushed), (viaS3 ? '<button class="btn small" data-act="import">Run the MCE import now</button>' : '') + payload('Show what was sent', pushed.detail), 'to-mce');
  } else {
    step(scored ? 'active' : 'wait', 'Model pushes the prediction back to Marketing Cloud');
  }

  if (failed) step('done', 'Something failed', esc(failed.title), at(failed), payload('Show error', failed.detail));
  return { steps, pushed };
}

function renderTrace() {
  const t = current();
  if (!t) return;
  $('#traceTitle').textContent = `${t.firstName}'s trip through Marketing Cloud`;
  const run = currentRun(t.contactKey);
  if (!run.length) {
    $('#traceSub').textContent = `Send ${t.firstName} into the journey and each call between Marketing Cloud and the model shows up here as it happens.`;
    $('#trace').innerHTML = '';
    renderLanded(null);
    return;
  }
  const { steps, pushed } = buildSteps(run);
  $('#traceSub').innerHTML = `Latest entry at ${clock(run[0].ts)}. <span class="legend"><span class="l-from">Marketing Cloud called the model</span><span class="l-to">Model called Marketing Cloud</span></span>`;
  $('#trace').innerHTML = steps.map((s) => `
    <li class="step ${s.status} ${s.cls}">
      <span class="mark">${s.status === 'done' ? CHECK : ''}</span>
      <h3>${s.title}</h3>
      <span class="when">${s.when}</span>
      ${s.what ? `<p class="what">${s.what}</p>` : ''}
      ${s.extra}
    </li>`).join('');
  renderLanded(pushed);
}

// Read the row back from MCE and Databricks once the model has pushed it.
async function checkLanded(key, eventId) {
  state.landed[key] = { eventId, loading: true };
  renderLanded(true);
  try {
    state.landed[key] = { eventId, ...(await api(`/api/travelers/${encodeURIComponent(key)}/landed`)) };
  } catch (err) {
    state.landed[key] = { eventId, error: err.message };
  }
  if (state.focus === key) renderLanded(true);
}

function storeBlock(title, where, res, fields, scoredAt) {
  if (!res) return `<div class="store"><div class="store-head"><b>${title}</b></div><p class="empty">Not connected.</p></div>`;
  if (res.error) return `<div class="store"><div class="store-head"><b>${title}</b></div><p class="empty">Couldn't read it: ${esc(res.error)}</p></div>`;
  if (!res.row) return `<div class="store"><div class="store-head"><b>${title}</b><small>read in ${secs(res.ms)}</small></div><code>${where}</code><p class="empty">No row yet.</p></div>`;
  const rows = fields.map(([label, k]) => `<dt>${label}</dt><dd>${esc(res.row[k] ?? '')}</dd>`).join('');
  return `<div class="store"><div class="store-head"><b>${title}</b><small>read in ${secs(res.ms)}</small></div><code>${where}</code><dl>${rows}</dl></div>`;
}

function renderLanded(pushed) {
  const t = current();
  const el = $('#landed');
  if (!t) return;
  const l = state.landed[t.contactKey];
  if (pushed && pushed.id && (!l || l.eventId !== pushed.id)) { checkLanded(t.contactKey, pushed.id); return; }
  const head = `<h3>Where ${esc(t.firstName)}'s prediction lives now</h3>`;
  if (!l) {
    el.innerHTML = `${head}<p>After the model pushes its async result, this panel reads the row back from Marketing Cloud, Databricks, and Data 360.</p>
      <button class="btn outline small" data-act="landed">Check now</button>`;
    return;
  }
  if (l.loading) { el.innerHTML = `${head}<p>Reading the row back from Marketing Cloud, Databricks, and Data 360.</p>`; return; }
  el.innerHTML = `${head}<p>Live read-back, not cached by this app.</p>
    ${storeBlock('Marketing Cloud', 'Expedia_Saturation_Predictions', l.mce, [['Prediction', 'prediction'], ['Score', 'saturationscore'], ['Source', 'scoringmode'], ['Scored at', 'scoredat']])}
    ${storeBlock('Databricks', 'main.expedia_sat.saturation_predictions', l.databricks, [['Prediction', 'prediction'], ['Score', 'saturation_score'], ['Source', 'scoring_mode'], ['Scored at', 'scored_at']])}
    ${storeBlock('Data 360, zero copy', 'EXP_SaturationPrediction__dlm', l.d360, [['Prediction', 'EXP_Prediction__c'], ['Score', 'EXP_SaturationScore__c'], ['Source', 'EXP_ScoringMode__c'], ['Scored at', 'EXP_ScoredAt__c']])}
    <button class="btn outline small" data-act="landed">Check again</button>`;
}

// ---------- travelers band ----------
function renderCards() {
  $('#cards').innerHTML = state.travelers.map((t) => {
    const p = t.lastPrediction;
    const f = t.features;
    return `
    <button class="card ${t.contactKey === state.focus ? 'selected' : ''}" data-key="${esc(t.contactKey)}" aria-pressed="${t.contactKey === state.focus}">
      <div class="card-top tier-${esc(t.tier)}"><span class="initials" aria-hidden="true">${esc(initials(t))}</span>${f.daysToNextTrip != null ? `<span class="flag">Trip in ${f.daysToNextTrip} days</span>` : ''}</div>
      <div class="card-body">
        <h3>${esc(t.firstName)} ${esc(t.lastName)}</h3>
        <p class="home">${esc(t.homeAirport)}, ${esc(t.persona.split(',')[0])}</p>
        <div class="rating"><span class="badge ${p ? p.prediction : 'none'}">${p ? p.saturationScore.toFixed(2) : 'New'}</span><b>${p ? (p.prediction === 'send' ? 'Send' : 'Abstain') : 'Not scored'}</b></div>
        <span class="tierchip">${esc(t.tier)} member</span>
        <p class="facts">${f.sends7d} ${f.sends7d === 1 ? 'email' : 'emails'} this week <span>${pct(f.openRate30d)} opens</span></p>
      </div>
    </button>`;
  }).join('');
}

function renderLog() {
  $('#logCount').textContent = `(${state.events.length})`;
  $('#events').innerHTML = state.events.slice().reverse().slice(0, 200).map((e) => {
    const who = e.contactKey ? state.travelers.find((t) => t.contactKey === e.contactKey)?.firstName || e.contactKey : '';
    return `<li class="k-${e.kind.replace('.', '-')}"><header><span>${esc(e.kind)}${who ? `, ${esc(who)}` : ''}</span><time>${clock(e.ts)}</time></header><p>${esc(e.title)}</p></li>`;
  }).join('');
}

function renderControls() {
  const c = state.config;
  $('#threshold').value = c.threshold; $('#thresholdOut').textContent = Number(c.threshold).toFixed(2);
  $('#asyncDelay').value = c.asyncDelaySec; $('#asyncDelayOut').textContent = `${c.asyncDelaySec}s`;
  $('#cdcMode').value = c.cdcMode;
  $('#importBtn').hidden = !state.integrations.mceImport;
}

function renderAll() { renderTabs(); renderWidget(); renderVerdict(); renderTrace(); renderCards(); }

// ---------- data ----------
async function refreshTravelers() { state.travelers = (await api('/api/state')).travelers; }

async function loadState() {
  const s = await api('/api/state');
  Object.assign(state, { travelers: s.travelers, config: s.config, integrations: s.integrations });
  state.focus ||= s.travelers[0]?.contactKey;
  renderConnections(); renderControls(); renderAll();
}

async function poll() {
  try {
    const evs = await api(`/api/events?since=${state.since}`);
    const seen = new Set(state.events.map((e) => e.id));
    const fresh = evs.filter((e) => !seen.has(e.id));
    if (fresh.length) {
      state.events.push(...fresh);
      state.events.sort((a, b) => a.ts - b.ts);
      state.since = Math.max(state.since, ...evs.map((e) => e.ts)) - 1;
      if (fresh.some((e) => /^(mce|model|cdc)/.test(e.kind))) await refreshTravelers();
      renderAll(); renderLog();
    }
  } catch { /* keep polling */ }
  setTimeout(poll, 1500);
}

// ---------- interactions ----------
function select(key) {
  state.focus = key; renderAll();
}

async function act(name, btn) {
  const t = current();
  const key = encodeURIComponent(t.contactKey);
  btn.disabled = true;
  try {
    if (name === 'inject') {
      await api(`/api/travelers/${key}/inject`, { method: 'POST' });
      delete state.landed[t.contactKey];
      toast(`${t.firstName} entered the journey`);
    } else if (name === 'injectcd') {
      await api(`/api/travelers/${key}/inject`, { method: 'POST', body: { journey: 'contactdata' } });
      toast(`${t.firstName} entered the sync callout + contact data journey`);
    } else if (name === 'score') {
      await api(`/api/travelers/${key}/score`, { method: 'POST' });
    } else if (name === 'landed') {
      return checkLanded(t.contactKey, state.landed[t.contactKey]?.eventId);
    } else if (name === 'import') {
      await api('/api/mce-import', { method: 'POST' });
      toast('MCE import automation started');
      return;
    } else {
      const f = t.features;
      const patch = name === 'fatigue'
        ? { sends7d: f.sends7d + 2, sends30d: f.sends30d + 2, daysSinceLastEngaged: f.daysSinceLastEngaged + 2 }
        : { openRate30d: Math.min(0.6, +(f.openRate30d + 0.08).toFixed(2)), clickRate30d: Math.min(0.15, +(f.clickRate30d + 0.02).toFixed(2)), daysSinceLastEngaged: 0, unsubPageViews30d: 0 };
      await api(`/api/travelers/${key}/adjust`, { method: 'POST', body: patch });
      await api(`/api/travelers/${key}/score`, { method: 'POST' });
    }
    await refreshTravelers();
    renderAll();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('click', (e) => {
  const pick = e.target.closest('.tab, .card');
  if (pick) return select(pick.dataset.key);
  const btn = e.target.closest('button[data-act]');
  if (btn) act(btn.dataset.act, btn);
});

let cfgTimer;
function saveConfig(patch) {
  Object.assign(state.config, patch); renderControls();
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(() => api('/api/config', { method: 'POST', body: patch }).catch((err) => toast(err.message, true)), 400);
}
$('#threshold').addEventListener('input', (e) => saveConfig({ threshold: Number(e.target.value) }));
$('#asyncDelay').addEventListener('input', (e) => saveConfig({ asyncDelaySec: Number(e.target.value) }));
$('#cdcMode').addEventListener('change', (e) => saveConfig({ cdcMode: e.target.value }));

$('#resetBtn').addEventListener('click', async () => {
  await api('/api/reset', { method: 'POST' }); state.landed = {}; await loadState(); toast('Travelers reset');
});
$('#importBtn').addEventListener('click', (e) => act('import', e.currentTarget));
$('#batchBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Scoring';
  try {
    const sinks = ['databricks', ...(state.config.cdcMode !== 'rest' ? ['s3'] : [])];
    const r = await api('/api/batch', { method: 'POST', body: { sinks } });
    const err = Object.values(r.results).find((x) => x?.error);
    toast(err ? `Scored, but a write failed: ${err.error}` : `Scored ${r.rows.length} travelers and wrote them to ${sinks.join(' and ')}`, Boolean(err));
    await refreshTravelers(); renderAll();
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Score all travelers to Databricks'; }
});

loadState().then(poll);
