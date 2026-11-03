// Model → data extension eventing. No Journey Builder involved: each change rescores and upserts the DE row.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const state = { travelers: [], rows: [], flash: null };

const INPUTS = [
  ['sends7d', 'Emails this week', 0, 12, 1, (v) => v],
  ['openRate30d', 'Open rate, 30 days', 0, 0.6, 0.01, (v) => `${Math.round(v * 100)}%`],
  ['clickRate30d', 'Click rate, 30 days', 0, 0.15, 0.01, (v) => `${Math.round(v * 100)}%`],
  ['daysSinceLastEngaged', 'Days since engaged', 0, 60, 1, (v) => v],
];

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

function renderTravelers() {
  $('#travelers').innerHTML = state.travelers.map((t) => {
    const p = t.lastPrediction;
    const sliders = INPUTS.map(([k, label, min, max, step, fmt]) => `
      <label class="field">
        <span>${label} <output>${fmt(t.features[k])}</output></span>
        <input type="range" data-key="${esc(t.contactKey)}" data-f="${k}" min="${min}" max="${max}" step="${step}" value="${t.features[k]}">
      </label>`).join('');
    return `
    <article class="ev-card" data-key="${esc(t.contactKey)}">
      <header>
        <span class="avatar tier-${esc(t.tier)}" aria-hidden="true">${esc(t.firstName[0] + t.lastName[0])}</span>
        <div><h3>${esc(t.firstName)} ${esc(t.lastName)}</h3><small>${esc(t.contactKey)}, ${esc(t.tier)}</small></div>
        <span class="badge ${p ? p.prediction : 'none'}">${p ? `${p.prediction === 'send' ? 'Send' : 'Abstain'} ${p.saturationScore.toFixed(2)}` : 'Not scored'}</span>
      </header>
      <div class="ev-sliders">${sliders}</div>
    </article>`;
  }).join('');
}

function renderRows() {
  const known = new Set(state.travelers.map((t) => t.contactKey));
  const rows = state.rows.filter((r) => known.has(r.subscriberkey)).sort((a, b) => a.subscriberkey.localeCompare(b.subscriberkey));
  $('#deRows').innerHTML = rows.length ? rows.map((r) => `
    <tr class="${state.flash?.has(r.subscriberkey) ? 'flash' : ''}">
      <th scope="row">${esc(r.subscriberkey)}</th>
      <td><span class="badge ${esc(r.prediction)}">${esc(r.prediction)}</span></td>
      <td>${esc(r.saturationscore)}</td><td>${esc(r.recommendedholdhours)}h</td>
      <td>${esc(r.scoringmode)}</td><td>${r.scoredat ? clock(r.scoredat) : ''}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">No rows yet. Move a slider to event the first prediction.</td></tr>';
}

function log(text) {
  const li = document.createElement('li');
  li.innerHTML = `<time>${clock(Date.now())}</time> ${text}`;
  $('#log').prepend(li);
  while ($('#log').children.length > 8) $('#log').lastChild.remove();
}

async function readDe() {
  const r = await api('/api/de-rows');
  state.rows = r.rows;
  $('#deSub').innerHTML = `Read live from <code>Expedia_Saturation_Predictions</code> in ${r.ms} ms at ${clock(Date.now())}.`;
  renderRows();
}

// One change → one event. Debounced per traveler so dragging a slider sends one upsert.
const timers = {};
function queueEvent(key, features) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => sendEvent(key, features), 350);
}

async function sendEvent(key, features) {
  try {
    const r = await api(`/api/travelers/${encodeURIComponent(key)}/event`, { method: 'POST', body: { features } });
    const row = r.rows[0];
    const t = state.travelers.find((x) => x.contactKey === key);
    Object.assign(t.features, features);
    t.lastPrediction = { prediction: row.Prediction, saturationScore: row.SaturationScore };
    renderTravelers();
    log(`${esc(t.firstName)}: <b>${row.Prediction}</b> ${row.SaturationScore} upserted in ${r.upsertMs} ms${r.readBack ? ', read back from MCE' : ''}`);
    await flashRead([key]);
  } catch (err) { toast(err.message, true); }
}

async function flashRead(keys) {
  state.flash = new Set(keys);
  await readDe();
  setTimeout(() => { state.flash = null; renderRows(); }, 1600);
}

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'threshold') { $('#thr').textContent = Number(el.value).toFixed(2); return; }
  if (!el.dataset.f) return;
  const def = INPUTS.find((i) => i[0] === el.dataset.f);
  el.previousElementSibling.querySelector('output').textContent = def[5](Number(el.value));
  queueEvent(el.dataset.key, { [el.dataset.f]: Number(el.value) });
});

// A threshold change is a model change for everyone: re-event every traveler.
$('#threshold').addEventListener('change', async (e) => {
  try {
    const r = await api('/api/event-all', { method: 'POST', body: { threshold: Number(e.target.value) } });
    for (const row of r.rows) {
      const t = state.travelers.find((x) => x.contactKey === row.SubscriberKey);
      if (t) t.lastPrediction = { prediction: row.Prediction, saturationScore: row.SaturationScore };
    }
    renderTravelers();
    log(`Threshold ${Number(e.target.value).toFixed(2)}: <b>${r.rows.length}</b> rows upserted in ${r.upsertMs} ms`);
    await flashRead(r.rows.map((x) => x.SubscriberKey));
  } catch (err) { toast(err.message, true); }
});

$('#refresh').addEventListener('click', () => readDe().catch((err) => toast(err.message, true)));

(async () => {
  const s = await api('/api/state');
  state.travelers = s.travelers;
  $('#threshold').value = s.config.threshold; $('#thr').textContent = Number(s.config.threshold).toFixed(2);
  renderTravelers();
  await readDe().catch((err) => toast(err.message, true));
})();
