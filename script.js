const CLIENT_ID = '926576243590-0ffu3hgsn4qmsdua6bekbb0s7443j2cn.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const REDIRECT_URI = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? location.origin
  : 'https://mateooppen.github.io/Registro-financiero/';
const FILE_NAME = 'finanzas_data.json';
const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

let accessToken = null;
let tokenExpiry = 0;
let driveFileId = null;
let appData = { transactions: [], config: { closeDay: 25, cardName: 'Tarjeta' } };
let curY, curM;
let curType = 'expense', curPay = 'cash';
let chartInst = null;
let settingsOpen = false;
let saveTimer = null;

// ── AUTH ──────────────────────────────────────────────────────────

function buildAuthUrl() {
  const state = Math.random().toString(36).slice(2);
  sessionStorage.setItem('oauth_state', state);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'token',
    scope: SCOPE,
    state,
    prompt: 'select_account'
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

function saveToken(token, expiresIn) {
  accessToken = token;
  tokenExpiry = Date.now() + expiresIn * 1000;
  localStorage.setItem('fp_token', JSON.stringify({ token, expiry: tokenExpiry }));
  scheduleRenewal();
}

function loadTokenFromStorage() {
  try {
    const raw = localStorage.getItem('fp_token');
    if (!raw) return false;
    const { token, expiry } = JSON.parse(raw);
    if (Date.now() > expiry - 60000) { localStorage.removeItem('fp_token'); return false; }
    accessToken = token;
    tokenExpiry = expiry;
    return true;
  } catch { return false; }
}

function clearAuth() {
  accessToken = null;
  tokenExpiry = 0;
  clearTimeout(renewalTimer);
  localStorage.removeItem('fp_token');
  sessionStorage.removeItem('oauth_state');
}

// ── RENOVACIÓN DE SESIÓN ─────────────────────────────────────────

let renewalTimer = null;

function scheduleRenewal() {
  clearTimeout(renewalTimer);
  const timeLeft = tokenExpiry - Date.now();
  const renewIn = timeLeft - 5 * 60 * 1000;
  if (renewIn <= 0) return;
  renewalTimer = setTimeout(async () => {
    try {
      await silentRenew();
    } catch {
      showSessionBanner();
    }
  }, renewIn);
}

function silentRenew() {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    const state = Math.random().toString(36).slice(2);
    sessionStorage.setItem('oauth_state', state);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'token',
      scope: SCOPE,
      state,
      prompt: 'none'
    });
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      reject(new Error('timeout'));
    }, 10000);
    function handler(e) {
      if (e.origin !== location.origin || !e.data || e.data.type !== 'fp_token') return;
      window.removeEventListener('message', handler);
      clearTimeout(timeout);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      const p = new URLSearchParams(e.data.hash);
      const token = p.get('access_token');
      const expiresIn = parseInt(p.get('expires_in') || '0');
      if (p.get('error') || !token || p.get('state') !== state) {
        reject(new Error(p.get('error') || 'invalid'));
        return;
      }
      saveToken(token, expiresIn);
      resolve();
    }
    window.addEventListener('message', handler);
    iframe.src = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
    document.body.appendChild(iframe);
  });
}

function showSessionBanner() {
  const banner = document.getElementById('session-banner');
  if (banner) banner.classList.remove('hidden');
}

function renewSession() {
  document.getElementById('session-banner').classList.add('hidden');
  location.href = buildAuthUrl();
}

function signOut() {
  if (!confirm('¿Cerrar sesión?')) return;
  clearAuth();
  driveFileId = null;
  appData = { transactions: [], config: { closeDay: 25, cardName: 'Tarjeta' } };
  history.replaceState(null, '', location.pathname);
  showAuth();
}

// ── DRIVE ─────────────────────────────────────────────────────────

async function driveReq(url, opts = {}) {
  if (!accessToken || Date.now() > tokenExpiry - 60000) {
    clearAuth();
    showAuth('Tu sesión expiró. Volvé a ingresar.');
    throw new Error('token_expired');
  }
  const res = await fetch(url, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + accessToken, ...(opts.headers || {}) }
  });
  if (res.status === 401) {
    clearAuth();
    showAuth('Tu sesión expiró. Volvé a ingresar.');
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error('Drive error ' + res.status);
  return res;
}

async function loadOrCreateFile() {
  const res = await driveReq(
    'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name%3D%22' + FILE_NAME + '%22&fields=files(id)'
  );
  const data = await res.json();

  if (data.files && data.files.length > 0) {
    driveFileId = data.files[0].id;
    const fileRes = await driveReq('https://www.googleapis.com/drive/v3/files/' + driveFileId + '?alt=media');
    const json = await fileRes.json();
    if (json.transactions) appData.transactions = json.transactions;
    if (json.config) appData.config = { ...appData.config, ...json.config };
  } else {
    await createFile();
  }

  if (!appData.config) appData.config = {};
  if (!appData.config.rent) appData.config.rent = {};
}

async function createFile() {
  const meta = { name: FILE_NAME, parents: ['appDataFolder'] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', new Blob([JSON.stringify(appData)], { type: 'application/json' }));
  const res = await driveReq(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    { method: 'POST', body: form }
  );
  const d = await res.json();
  driveFileId = d.id;
}

async function saveToDrive() {
  if (!driveFileId || !accessToken) return;
  showSaveBar('Guardando en Drive...');
  try {
    await driveReq(
      'https://www.googleapis.com/upload/drive/v3/files/' + driveFileId + '?uploadType=media',
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(appData) }
    );
    showSaveBar('Guardado', true);
  } catch(e) {
    if (e.message !== 'token_expired' && e.message !== 'unauthorized') {
      showSaveBar('Error al guardar. Reintentando...');
      saveTimer = setTimeout(saveToDrive, 4000);
    }
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToDrive, 900);
}

// ── PANTALLAS ─────────────────────────────────────────────────────

async function showAuth(errorMsg) {
  const url = buildAuthUrl();
  document.getElementById('auth-link').href = url;
  const errEl = document.getElementById('auth-error');
  if (errorMsg) { errEl.textContent = errorMsg; errEl.classList.remove('hidden'); }
  else { errEl.classList.add('hidden'); }
  document.getElementById('screen-auth').classList.remove('hidden');
  document.getElementById('screen-loading').classList.add('hidden');
  document.getElementById('screen-app').classList.add('hidden');
  document.getElementById('month-nav').classList.add('hidden');
}

function showLoading(msg) {
  document.getElementById('loading-text').textContent = msg || 'Cargando...';
  document.getElementById('screen-auth').classList.add('hidden');
  document.getElementById('screen-loading').classList.remove('hidden');
  document.getElementById('screen-app').classList.add('hidden');
}

function showApp() {
  document.getElementById('screen-auth').classList.add('hidden');
  document.getElementById('screen-loading').classList.add('hidden');
  document.getElementById('screen-app').classList.remove('hidden');
  document.getElementById('month-nav').classList.remove('hidden');
  setType('expense');
  const now = new Date();
  curY = now.getFullYear(); curM = now.getMonth();
  document.getElementById('date-inp').value = now.toISOString().split('T')[0];
  document.getElementById('card-name-inp').value = appData.config.cardName;
  document.getElementById('close-day-inp').value = appData.config.closeDay;
  // Poblar select de años para alquiler
  const ySel = document.getElementById('rent-start-month-y');
  ySel.innerHTML = '<option value="">Año</option>';
  for (let y = now.getFullYear() - 5; y <= now.getFullYear() + 2; y++) {
    ySel.innerHTML += `<option value="${y}">${y}</option>`;
  }
  // Cargar valores de alquiler en los inputs si existen
  const rc = appData.config.rent;
  if (rc && rc.baseAmount) {
    document.getElementById('rent-base-amount').value = rc.baseAmount;
    document.getElementById('rent-day').value = rc.day;
    if (rc.startMonth) {
      const [sy, sm] = rc.startMonth.split('-');
      document.getElementById('rent-start-month-m').value = sm;
      document.getElementById('rent-start-month-y').value = sy;
    }
    document.getElementById('rent-freq').value = rc.increaseFreq;
    document.getElementById('rent-percent').value = rc.percent;
  }

  checkAndGenerateRent();
  updateRentBanner();
  render();
}

function showSaveBar(msg, success) {
  const bar = document.getElementById('save-bar');
  document.getElementById('save-bar-text').textContent = msg;
  bar.classList.remove('hidden');
  if (success) setTimeout(() => bar.classList.add('hidden'), 2000);
}

// ── LÓGICA ────────────────────────────────────────────────────────

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmt(v) { return '$' + Math.abs(v).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function mkey(y, m) { return y + '-' + String(m + 1).padStart(2, '0'); }
function fmtDate(s) { const [, mo, d] = s.split('-'); return d + '/' + mo; }

function computeImpactKey(dateStr, closeDay) {
  const p = dateStr.split('-').map(Number), y = p[0], m = p[1] - 1, d = p[2];
  let startY, startM;
  if (d <= closeDay) {
    startM = m + 1; startY = y;
    if (startM > 11) { startM = 0; startY++; }
  } else {
    startM = m + 2; startY = y;
    while (startM > 11) { startM -= 12; startY++; }
  }
  return mkey(startY, startM);
}

function computeImpactKeys(dateStr, closeDay, installments) {
  const first = computeImpactKey(dateStr, closeDay);
  if (installments <= 1) return [first];
  const [fy, fm] = first.split('-').map(Number);
  const keys = [];
  for (let i = 0; i < installments; i++) {
    let mm = fm - 1 + i, yy = fy;
    while (mm > 11) { mm -= 12; yy++; }
    keys.push(mkey(yy, mm));
  }
  return keys;
}

function setType(t) {
  curType = t;
  document.getElementById('btn-inc').className = t === 'income' ? 'act-inc' : '';
  document.getElementById('btn-exp').className = t === 'expense' ? 'act-exp' : '';
  document.getElementById('pay-toggle').classList.toggle('hidden', t !== 'expense');
}

function setPayment(p) {
  curPay = p;
  document.getElementById('btn-cash').className = p === 'cash' ? 'act-cash' : '';
  document.getElementById('btn-card').className = p === 'card' ? 'act-card' : '';
  document.getElementById('installments-inp').classList.toggle('hidden', p !== 'card');
  if (p !== 'card') document.getElementById('installments-inp').value = '1';
}

let rentSettingsOpen = false;
function toggleRentSettings() {
  rentSettingsOpen = !rentSettingsOpen;
  document.getElementById('rent-body').classList.toggle('hidden', !rentSettingsOpen);
  document.getElementById('rent-chevron').style.transform = rentSettingsOpen ? 'rotate(180deg)' : '';
  document.getElementById('rent-toggle').setAttribute('aria-expanded', rentSettingsOpen);
}

function toggleSettings() {
  settingsOpen = !settingsOpen;
  document.getElementById('settings-body').classList.toggle('hidden', !settingsOpen);
  document.getElementById('settings-chevron').style.transform = settingsOpen ? 'rotate(180deg)' : '';
  document.getElementById('settings-toggle').setAttribute('aria-expanded', settingsOpen);
}

function saveSettings() {
  const name = document.getElementById('card-name-inp').value.trim() || 'Tarjeta';
  const day = Math.min(31, Math.max(1, parseInt(document.getElementById('close-day-inp').value) || 25));
  appData.config.cardName = name;
  appData.config.closeDay = day;
  toggleSettings();
  scheduleSave();
  toast('Configuración guardada');
  render();
}

function resetForm() {
  document.getElementById('desc-inp').value = '';
  document.getElementById('amount-inp').value = '';
  document.getElementById('date-inp').value = new Date().toISOString().split('T')[0];
  document.getElementById('installments-inp').value = '1';
  setType('expense');
  setPayment('cash');
}

function addTx() {
  const desc = document.getElementById('desc-inp').value.trim();
  const amount = parseFloat(document.getElementById('amount-inp').value);
  const date = document.getElementById('date-inp').value;
  if (!desc || isNaN(amount) || amount <= 0 || !date) { toast('Completá descripción, monto y fecha'); return; }
  const payMethod = curType === 'expense' ? curPay : 'income';
  const tx = { id: Date.now(), type: curType, payMethod, desc, amount, date };
  if (curType === 'expense' && curPay === 'card') {
    const installments = parseInt(document.getElementById('installments-inp').value) || 1;
    tx.installments = installments;
    tx.installmentAmount = Math.round(amount / installments);
    tx.impactKeys = computeImpactKeys(date, appData.config.closeDay, installments);
    tx.impactKey = tx.impactKeys[0];
  }
  appData.transactions.push(tx);
  resetForm();
  scheduleSave();
  toast('Movimiento agregado');
  render();
}

function deleteTx(id) {
  if (!confirm('¿Eliminar este movimiento?')) return;
  appData.transactions = appData.transactions.filter(t => t.id !== id);
  scheduleSave();
  render();
}

function getStats(y, m) {
  const key = mkey(y, m), txs = appData.transactions;
  const mtx = txs.filter(t => t.date && t.date.startsWith(key));
  const income = mtx.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const cashExp = mtx.filter(t => t.type === 'expense' && t.payMethod === 'cash').reduce((s, t) => s + t.amount, 0);
  const cardAcc = mtx.filter(t => t.type === 'expense' && t.payMethod === 'card').reduce((s, t) => s + t.amount, 0);
  let cardImpact = 0;
  let cardImpactNew = 0;
  let cardImpactPrev = 0;
  txs.forEach(t => {
    if (t.payMethod !== 'card') return;
    const txMonth = t.date ? t.date.slice(0, 7) : '';
    if (t.impactKeys) {
      const idx = t.impactKeys.indexOf(key);
      if (idx !== -1) {
        const amt = t.installmentAmount || Math.round(t.amount / (t.installments || 1));
        cardImpact += amt;
        if (txMonth === key) cardImpactNew += amt; else cardImpactPrev += amt;
      }
    } else if (t.impactKey === key) {
      cardImpact += t.amount;
      if (txMonth === key) cardImpactNew += t.amount; else cardImpactPrev += t.amount;
    }
  });
  return { income, cashExp, cardAcc, cardImpact, cardImpactNew, cardImpactPrev, balance: income - cashExp - cardImpact, monthTx: mtx };
}

// ── RENDER ────────────────────────────────────────────────────────

function render() {
  const cfg = appData.config;
  document.getElementById('month-lbl').textContent = MONTHS[curM] + ' ' + curY;
  const { income, cashExp, cardAcc, cardImpact, cardImpactNew, cardImpactPrev, balance, monthTx } = getStats(curY, curM);

  let creditLabel = fmt(cardAcc);
  const creditParts = [];
  if (cardAcc > 0) creditParts.push('consumido: ' + fmt(cardAcc));
  if (cardImpactPrev > 0) creditParts.push('cuotas: ' + fmt(cardImpactPrev));
  const creditSub = creditParts.length > 0 ? '<div class="credit-sub">' + creditParts.join(' + ') + '</div>' : '';

  document.getElementById('metrics-grid').innerHTML = `
    <div class="metric"><div class="metric-label"><i class="ti ti-arrow-down-circle green" aria-hidden="true"></i>Ingresos</div><div class="metric-value green">${fmt(income)}</div></div>
    <div class="metric"><div class="metric-label"><i class="ti ti-cash red" aria-hidden="true"></i>Gastos contado</div><div class="metric-value red">${fmt(cashExp)}</div></div>
    <div class="metric"><div class="metric-label"><i class="ti ti-credit-card blue" aria-hidden="true"></i>Crédito este mes</div><div class="metric-value blue">${fmt(cardAcc + cardImpactPrev)}</div>${creditSub}</div>
    <div class="metric"><div class="metric-label"><i class="ti ti-scale" aria-hidden="true"></i>Balance real</div><div class="metric-value ${balance >= 0 ? 'pos' : 'neg'}">${balance < 0 ? '-' : ''}${fmt(balance)}</div></div>
  `;

  document.getElementById('credit-banner').classList.add('hidden');

  const sorted = [...monthTx].sort((a, b) => b.date.localeCompare(a.date));
  const list = document.getElementById('tx-list');
  if (!sorted.length) {
    list.innerHTML = '<div class="empty"><i class="ti ti-inbox" aria-hidden="true"></i>No hay movimientos este mes</div>';
  } else {
    list.innerHTML = sorted.map(t => {
      const dc = t.type === 'income' ? 'income' : t.payMethod === 'card' ? 'card' : 'cash';
      const prefix = t.type === 'income' ? '+' : '-';
      let sub;
      if (t.payMethod === 'card') {
        const inst = t.installments || 1;
        const keys = t.impactKeys || (t.impactKey ? [t.impactKey] : []);
        if (inst > 1) {
          sub = `${cfg.cardName} · ${inst} cuotas de ${fmt(t.installmentAmount)} · ${keys[0]} a ${keys[keys.length-1]}`;
        } else {
          sub = `${cfg.cardName} · impacta ${keys[0] || ''}`;
        }
      } else {
        sub = t.type === 'income' ? 'Ingreso' : 'Contado';
      }
      const amountDisplay = t.payMethod === 'card' && (t.installments || 1) > 1
        ? `${fmt(t.amount)}`
        : `${fmt(t.amount)}`;
      return `<div class="tx-item">
        <span class="tx-dot ${dc}" aria-hidden="true"></span>
        <div class="tx-main">
          <div class="tx-desc">${esc(t.desc)}</div>
          <div class="tx-sub">${fmtDate(t.date)} · ${sub}</div>
        </div>
        <div class="tx-right">
          <span class="tx-amount ${dc}">${prefix}${amountDisplay}</span>
          <button class="tx-del" onclick="deleteTx(${t.id})" aria-label="Eliminar movimiento"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>
      </div>`;
    }).join('');
  }
  renderInstallments();
  // NO ELIMINAR: renderChart genera el gráfico de 6 meses, deshabilitado temporalmente.
  // renderChart();
  renderHist(cfg);
}

function toggleInstDetail() {
  const d = document.getElementById('inst-detail');
  const b = document.getElementById('inst-toggle-btn');
  const open = d.classList.toggle('hidden');
  b.innerHTML = !open
    ? '<i class="ti ti-chevron-up icon-md" aria-hidden="true"></i> Ocultar detalle'
    : '<i class="ti ti-chevron-down icon-md" aria-hidden="true"></i> Ver detalle de cuotas';
}

function renderInstallments() {
  const txs = appData.transactions.filter(t => t.payMethod === 'card' && (t.installments || 1) > 1);
  const cfg = appData.config;
  if (!txs.length) { document.getElementById('installments-card').classList.add('hidden'); return; }
  document.getElementById('installments-card').classList.remove('hidden');

  const now = new Date();
  const currentKey = mkey(now.getFullYear(), now.getMonth());
  const monthMap = {};

  txs.forEach(t => {
    const keys = t.impactKeys || [];
    const inst = t.installments || 1;
    const amt = t.installmentAmount || Math.round(t.amount / inst);
    keys.forEach((k, idx) => {
      if (k < currentKey) return;
      if (!monthMap[k]) monthMap[k] = { total: 0, items: [], finishes: 0 };
      monthMap[k].total += amt;
      monthMap[k].items.push({ desc: t.desc, cuota: idx + 1, of: inst, amount: amt, isLast: idx + 1 === inst });
      if (idx + 1 === inst) monthMap[k].finishes++;
    });
  });

  const sortedKeys = Object.keys(monthMap).sort();
  if (!sortedKeys.length) { document.getElementById('installments-card').classList.add('hidden'); return; }

  const lastKey = sortedKeys[sortedKeys.length - 1];
  const [ly, lm] = lastKey.split('-').map(Number);
  let freeM = lm, freeY = ly;
  freeM++;
  if (freeM > 12) { freeM = 1; freeY++; }
  const freeKey = mkey(freeY, freeM - 1);

  const fmtK = v => {
    if (v >= 1000000) return '$' + Math.round(v / 1000000) + 'M';
    if (v >= 1000) return '$' + Math.round(v / 1000) + 'k';
    return '$' + v;
  };
  let pills = sortedKeys.map(k => {
    const d = monthMap[k];
    const [y, m] = k.split('-').map(Number);
    const mName = MONTHS[m - 1].slice(0, 3);
    const finBadge = d.finishes > 0
      ? `<span class="mp-fin"><i class="ti ti-check icon-xs" aria-hidden="true"></i>${d.finishes}</span>`
      : '';
    return `<div class="mp"><div class="mp-top"><span class="mp-month">${mName}</span>${finBadge}</div><div class="mp-amount">${fmtK(d.total)}</div></div>`;
  }).join('');
  pills += `<div class="mp free"><div class="mp-top"><span class="mp-month">${MONTHS[freeM - 1].slice(0, 3)}</span></div><div class="mp-amount zero">libre</div></div>`;
  document.getElementById('inst-summary').innerHTML = pills;

  let detail = sortedKeys.map(k => {
    const d = monthMap[k];
    const [y, m] = k.split('-').map(Number);
    let html = `<div class="inst-mh"><span class="inst-mh-name">${MONTHS[m - 1]} ${y}</span><span class="inst-mh-total">${fmt(d.total)}</span></div>`;
    d.items.forEach(item => {
      const badgeCls = item.isLast ? 'inst-badge last' : 'inst-badge';
      const badgeText = item.isLast ? `${item.cuota}/${item.of} última` : `${item.cuota}/${item.of}`;
      html += `<div class="inst-row"><span class="inst-desc">${esc(item.desc)}</span><span class="${badgeCls}">${badgeText}</span><span class="inst-amt">${fmt(item.amount)}</span></div>`;
    });
    return html;
  }).join('');
  document.getElementById('inst-detail').innerHTML = detail;
}

function renderChart() {
  const months = [];
  for (let i = 5; i >= 0; i--) { let m = curM - i, y = curY; while (m < 0) { m += 12; y--; } months.push({ y, m }); }
  const labels = months.map(({ m }) => MONTHS[m].slice(0, 3));
  const inc  = months.map(({ y, m }) => getStats(y, m).income);
  const cash = months.map(({ y, m }) => getStats(y, m).cashExp);
  const card = months.map(({ y, m }) => getStats(y, m).cardImpact);
  if (chartInst) chartInst.destroy();
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  chartInst = new Chart(document.getElementById('hist-chart'), {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Ingresos', data: inc,  backgroundColor: '#5DCAA5', borderRadius: 3 },
      { label: 'Contado',  data: cash, backgroundColor: '#F0997B', borderRadius: 3 },
      { label: 'Crédito cobrado', data: card, backgroundColor: '#85B7EB', borderRadius: 3 }
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, color: dark ? '#6a6a66' : '#9b9b97', autoSkip: false } },
        y: { grid: { color: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }, ticks: { font: { size: 10 }, color: dark ? '#6a6a66' : '#9b9b97', callback: v => '$' + v.toLocaleString('es-AR') } }
      }
    }
  });
}

function renderHist(cfg) {
  const months = [];
  for (let i = 5; i >= 0; i--) { let m = curM - i, y = curY; while (m < 0) { m += 12; y--; } months.push({ y, m }); }
  const cur = mkey(curY, curM);
  document.getElementById('hist-row').innerHTML = months.map(({ y, m }) => {
    const k = mkey(y, m);
    const { income, cashExp, cardImpact, balance } = getStats(y, m);
    return `<div class="hist-card${k === cur ? ' active' : ''}" onclick="goMonth(${y},${m})">
      <div class="hist-month">${MONTHS[m].slice(0, 3)} ${y}</div>
      <div class="hist-nums">
        <span class="hist-income">+${fmt(income)}</span>
        <span class="hist-expense">-${fmt(cashExp + cardImpact)}</span>
        <span class="hist-balance ${balance >= 0 ? 'pos' : 'neg'}">${balance < 0 ? '-' : ''}${fmt(balance)}</span>
      </div>
    </div>`;
  }).join('');
}

function goMonth(y, m) { curY = y; curM = m; render(); }

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

document.getElementById('prev-m').addEventListener('click', () => { curM--; if (curM < 0) { curM = 11; curY--; } render(); });
document.getElementById('next-m').addEventListener('click', () => { curM++; if (curM > 11) { curM = 0; curY++; } render(); });

// ── ALQUILER ─────────────────────────────────────────────────────

function getRentAmountForDate(targetDate, config) {
    const start = new Date(config.startMonth + "-01T00:00:00");
    const target = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);

    let monthsDiff = (target.getFullYear() - start.getFullYear()) * 12 + (target.getMonth() - start.getMonth());
    if (monthsDiff < 0) return null;

    const periods = Math.floor(monthsDiff / config.increaseFreq);
    const finalAmount = config.baseAmount * Math.pow(1 + (config.percent / 100), periods);

    return Math.round(finalAmount);
}

async function checkAndGenerateRent() {
    const conf = appData.config.rent;
    if (!conf || !conf.baseAmount) return;

    const today = new Date();
    const start = new Date(conf.startMonth + "-01T00:00:00");
    let current = new Date(start);
    let updated = false;

    while (current <= today) {
        const monthKey = current.toISOString().slice(0, 7);
        const dayToPay = Math.min(conf.day, new Date(current.getFullYear(), current.getMonth() + 1, 0).getDate());
        const paymentDate = `${monthKey}-${String(dayToPay).padStart(2, '0')}`;

        if (new Date(paymentDate + "T00:00:00") <= today) {
            const exists = appData.transactions.find(t => t.source === 'rent' && t.date.startsWith(monthKey));

            if (!exists) {
                const amount = getRentAmountForDate(current, conf);
                const newTx = {
                    id: Date.now() + Math.random(),
                    type: 'income',
                    payMethod: 'cash',
                    desc: 'Alquiler (Automático)',
                    amount: amount,
                    date: paymentDate,
                    source: 'rent'
                };
                appData.transactions.push(newTx);
                updated = true;
            }
        }
        current.setMonth(current.getMonth() + 1);
    }

    if (updated) {
        appData.transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
        await scheduleSave();
        render();
    }
}

function saveRentConfig() {
  appData.config.rent = {
      baseAmount: parseFloat(document.getElementById('rent-base-amount').value),
      day: parseInt(document.getElementById('rent-day').value),
      startMonth: document.getElementById('rent-start-month-y').value + '-' + document.getElementById('rent-start-month-m').value,
      increaseFreq: parseInt(document.getElementById('rent-freq').value),
      percent: parseFloat(document.getElementById('rent-percent').value),
      lastDismissed: (appData.config.rent && appData.config.rent.lastDismissed) || null
  };
  scheduleSave();
  alert("Configuración de alquiler guardada. Se registrarán los cobros pendientes.");
  checkAndGenerateRent();
  updateRentBanner();
}

function updateRentBanner() {
    const conf = appData.config.rent;
    const banner = document.getElementById('rent-banner');
    if (!conf || !conf.baseAmount) return banner.classList.add('hidden');

    const today = new Date();
    const start = new Date(conf.startMonth + "-01T00:00:00");

    let nextIncreaseDate = new Date(start);
    while (nextIncreaseDate <= today) {
        nextIncreaseDate.setMonth(nextIncreaseDate.getMonth() + parseInt(conf.increaseFreq));
    }

    const diffDays = Math.ceil((nextIncreaseDate - today) / (1000 * 60 * 60 * 24));

    if (diffDays <= 10 && diffDays > 0) {
        const nextMonthKey = nextIncreaseDate.toISOString().slice(0, 7);
        if (conf.lastDismissed === nextMonthKey) return banner.classList.add('hidden');

        const currentAmount = getRentAmountForDate(today, conf);
        const nextAmount = getRentAmountForDate(nextIncreaseDate, conf);

        document.getElementById('rent-banner-text').innerHTML =
            `<b>Aumento en ${diffDays} días:</b> El alquiler pasará de $${currentAmount.toLocaleString()} a $${nextAmount.toLocaleString()} (+${conf.percent}%)`;
        banner.classList.remove('hidden');
    } else {
        banner.classList.add('hidden');
    }
}

function dismissRentBanner() {
    const conf = appData.config.rent;
    const today = new Date();
    let nextIncreaseDate = new Date(conf.startMonth + "-01T00:00:00");
    while (nextIncreaseDate <= today) {
        nextIncreaseDate.setMonth(nextIncreaseDate.getMonth() + parseInt(conf.increaseFreq));
    }
    conf.lastDismissed = nextIncreaseDate.toISOString().slice(0, 7);
    document.getElementById('rent-banner').classList.add('hidden');
    scheduleSave();
}

// ── INIT ──────────────────────────────────────────────────────────

async function init() {
  // Si estamos dentro de un iframe (renovación silenciosa), enviar token al padre y salir
  if (window.parent !== window && location.hash) {
    window.parent.postMessage({ type: 'fp_token', hash: location.hash.slice(1) }, location.origin);
    return;
  }

  const hash = location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const token = params.get('access_token');
    const expiresIn = parseInt(params.get('expires_in') || '0');
    const state = params.get('state');
    const error = params.get('error');
    history.replaceState(null, '', location.pathname);

    if (error) {
      await showAuth(error === 'access_denied'
        ? 'Acceso denegado. Solo cuentas autorizadas pueden ingresar.'
        : 'Error de autenticación. Intentá de nuevo.');
      return;
    }

    if (token) {
      const savedState = sessionStorage.getItem('oauth_state');
      if (state !== savedState) {
        await showAuth('Error de seguridad. Intentá de nuevo.');
        return;
      }
      sessionStorage.removeItem('oauth_state');
      saveToken(token, expiresIn);
      showLoading('Cargando tus datos...');
      try {
        await loadOrCreateFile();
        showApp();
      } catch(e) {
        if (e.message !== 'token_expired' && e.message !== 'unauthorized') {
          await showAuth('Error al conectar con Drive. Intentá de nuevo.');
        }
      }
      return;
    }
  }

  if (loadTokenFromStorage()) {
    scheduleRenewal();
    showLoading('Cargando tus datos...');
    try {
      await loadOrCreateFile();
      showApp();
    } catch(e) {
      if (e.message !== 'token_expired' && e.message !== 'unauthorized') {
        await showAuth('Error al conectar con Drive. Intentá de nuevo.');
      }
    }
    return;
  }

  await showAuth();
}

init();
