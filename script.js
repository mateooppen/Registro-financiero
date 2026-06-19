// ── TEMA ─────────────────────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
})();

function toggleTheme() {
  const root = document.documentElement;
  const current = root.getAttribute('data-theme');
  let next;
  if (!current) {
    // Primera vez: detectar tema actual del sistema e invertir
    next = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark';
  } else {
    next = current === 'dark' ? 'light' : 'dark';
  }
  root.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon();
}

function updateThemeIcon() {
  const btn = document.getElementById('theme-btn');
  if (!btn) return;
  const root = document.documentElement;
  const theme = root.getAttribute('data-theme');
  let isDark;
  if (theme) {
    isDark = theme === 'dark';
  } else {
    isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  btn.innerHTML = isDark
    ? '<i class="ti ti-sun" aria-hidden="true"></i>'
    : '<i class="ti ti-moon" aria-hidden="true"></i>';
}

document.addEventListener('DOMContentLoaded', updateThemeIcon);

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
let appData = { transactions: [], config: { closeDay: 25, cardName: 'Mastercard', dueDay: 5 } };
let curY, curM;
let curType = 'expense', curPay = 'cash', curAccount = 'fixed';
let chartInst = null;
const ACCOUNT_COLORS = ['#5fa8e0','#2ec48f','#e87654','#EF9F27','#a87ee6','#4A90A8','#E06B9E','#8B8B87'];
const DEFAULT_ACCOUNTS = [
  { id: 'fixed', name: 'Ingresos Fijos', color: '#5fa8e0' },
  { id: 'variable', name: 'Ingresos Variables', color: '#2ec48f' }
];
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
  appData = { transactions: [], config: { closeDay: 25, cardName: 'Mastercard', dueDay: 5 } };
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
  migrateData();
}

function migrateData() {
  if (!appData.config.accounts) appData.config.accounts = JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS));
  // Agregar color a cuentas sin color
  appData.config.accounts.forEach((a, i) => {
    if (!a.color) a.color = ACCOUNT_COLORS[i % ACCOUNT_COLORS.length];
  });
  let changed = false;
  const fallbackAcc = (appData.config.accounts.find(a => !PROTECTED_ACCOUNTS.includes(a.id)) || appData.config.accounts[0]).id;
  appData.transactions.forEach(t => {
    if (t.account) return;
    changed = true;
    if (t.source === 'rent') t.account = 'fixed';
    else if (t.payMethod === 'card') t.account = 'fixed';
    else if (t.type === 'income') t.account = fallbackAcc;
    else t.account = fallbackAcc;
  });
  if (changed) scheduleSave();
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
  document.getElementById('card-name-inp').value = appData.config.cardName || 'Mastercard';
  document.getElementById('close-day-inp').value = appData.config.closeDay;
  document.getElementById('due-day-inp').value = appData.config.dueDay || 5;
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
  checkAndGenerateCardDebit();
  updateRentBanner();
  updateCardBanner();
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
function fmtK(v) {
  if (v >= 1000000) { const n = v / 1000000; return '$' + (n % 1 === 0 ? n : n.toFixed(1)) + 'M'; }
  if (v >= 1000) { const n = v / 1000; return '$' + (n % 1 === 0 ? n : n.toFixed(1)) + 'k'; }
  return '$' + v;
}
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
  updateAccountToggle();
}

function setPayment(p) {
  curPay = p;
  document.getElementById('btn-cash').className = p === 'cash' ? 'act-cash' : '';
  document.getElementById('btn-card').className = p === 'card' ? 'act-card' : '';
  document.getElementById('installments-inp').classList.toggle('hidden', p !== 'card');
  if (p !== 'card') document.getElementById('installments-inp').value = '1';
  updateAccountToggle();
}

function setAccount(a) {
  curAccount = a;
}

function updateAccountToggle() {
  const active = getActiveAccounts();
  const show = curType === 'expense' && curPay === 'cash' && active.length > 1;
  const sel = document.getElementById('account-select');
  sel.classList.toggle('hidden', !show);
  if (show) renderAccountSelect();
}

function renderAccountSelect() {
  const accounts = getActiveAccounts();
  const sel = document.getElementById('account-select');
  sel.innerHTML = accounts.map(a =>
    `<option value="${a.id}"${a.id === curAccount ? ' selected' : ''}>${esc(a.name)}</option>`
  ).join('');
}

function getAccountName(accountId) {
  const accounts = appData.config.accounts || DEFAULT_ACCOUNTS;
  const acc = accounts.find(a => a.id === accountId);
  return acc ? acc.name : '';
}

function getActiveAccounts() {
  return (appData.config.accounts || DEFAULT_ACCOUNTS).filter(a => a.enabled !== false);
}

// ── CONFIGURACIÓN DE CUENTAS ─────────────────────────────────────

let accountsSettingsOpen = false;

function toggleAccountsSettings() {
  accountsSettingsOpen = !accountsSettingsOpen;
  const body = document.getElementById('accounts-body');
  animateToggle(body, accountsSettingsOpen);
  document.getElementById('accounts-chevron').style.transform = accountsSettingsOpen ? 'rotate(180deg)' : '';
  document.getElementById('accounts-toggle').setAttribute('aria-expanded', accountsSettingsOpen);
  if (accountsSettingsOpen) renderAccountsSettings();
}

function renderAccountsSettings() {
  const accounts = appData.config.accounts || DEFAULT_ACCOUNTS;
  const list = document.getElementById('accounts-list');
  list.innerHTML = accounts.map((a, i) => {
    const colorOptions = ACCOUNT_COLORS.map(c =>
      `<span class="color-swatch${c === a.color ? ' active' : ''}" style="background:${c}" onclick="setAccountColor('${a.id}','${c}')" aria-label="Color"></span>`
    ).join('');
    const isPrimary = PROTECTED_ACCOUNTS.includes(a.id);
    const isEnabled = a.enabled !== false;
    const disabledClass = !isEnabled ? ' account-disabled' : '';
    const toggleHtml = !isPrimary ? `<label class="acc-switch"><input type="checkbox" onchange="toggleAccountEnabled('${a.id}')" ${isEnabled ? 'checked' : ''}><span class="acc-switch-slider"></span></label>` : '';
    const delBtn = !isPrimary ? `<button class="account-del-btn" onclick="deleteAccount('${a.id}')" aria-label="Eliminar cuenta"><i class="ti ti-trash"></i></button>` : '';
    return `<div class="account-config-item${disabledClass}">
      <div class="account-config-row">
        <input type="text" class="account-name-inp" value="${esc(a.name)}" onchange="renameAccount('${a.id}', this.value)" placeholder="Nombre">
        ${toggleHtml}
        ${delBtn}
      </div>
      <div class="color-picker">${colorOptions}</div>
    </div>`;
  }).join('');
}

function renameAccount(id, newName) {
  const name = newName.trim();
  if (!name) return;
  const acc = appData.config.accounts.find(a => a.id === id);
  if (acc && acc.name !== name) {
    acc.name = name;
    scheduleSave();
    render();
  }
}

function setAccountColor(id, color) {
  const acc = appData.config.accounts.find(a => a.id === id);
  if (acc) {
    acc.color = color;
    scheduleSave();
    renderAccountsSettings();
    render();
  }
}

function addAccount() {
  const accounts = appData.config.accounts;
  const id = 'acc_' + Date.now();
  const usedColors = accounts.map(a => a.color);
  const color = ACCOUNT_COLORS.find(c => !usedColors.includes(c)) || ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length];
  accounts.push({ id, name: 'Nueva cuenta', color });
  scheduleSave();
  renderAccountsSettings();
  renderAccountSelect();
  render();
}

const PROTECTED_ACCOUNTS = ['fixed'];

function deleteAccount(id) {
  if (PROTECTED_ACCOUNTS.includes(id)) { toast('Esta cuenta no se puede eliminar'); return; }
  const accounts = appData.config.accounts;
  const acc = accounts.find(a => a.id === id);
  if (!acc) return;
  const txCount = appData.transactions.filter(t => t.account === id).length;
  const msg = txCount > 0
    ? '¿Eliminar "' + acc.name + '"?\n\nSe eliminarán permanentemente ' + txCount + ' movimiento(s). Esta acción no se puede deshacer.'
    : '¿Eliminar "' + acc.name + '"?';
  if (!confirm(msg)) return;
  appData.transactions = appData.transactions.filter(t => t.account !== id);
  appData.config.accounts = accounts.filter(a => a.id !== id);
  if (curAccount === id) curAccount = getActiveAccounts()[0].id;
  scheduleSave();
  renderAccountsSettings();
  renderAccountSelect();
  render();
}

function toggleAccountEnabled(id) {
  if (PROTECTED_ACCOUNTS.includes(id)) return;
  const acc = appData.config.accounts.find(a => a.id === id);
  if (!acc) return;
  acc.enabled = acc.enabled === false ? true : false;
  if (acc.enabled === false && curAccount === id) {
    curAccount = getActiveAccounts()[0].id;
  }
  scheduleSave();
  renderAccountsSettings();
  renderAccountSelect();
  render();
}

let rentSettingsOpen = false;
function toggleRentSettings() {
  rentSettingsOpen = !rentSettingsOpen;
  const body = document.getElementById('rent-body');
  animateToggle(body, rentSettingsOpen);
  document.getElementById('rent-chevron').style.transform = rentSettingsOpen ? 'rotate(180deg)' : '';
  document.getElementById('rent-toggle').setAttribute('aria-expanded', rentSettingsOpen);
}

function animateToggle(el, opening) {
  if (opening) {
    el.classList.remove('collapsed');
    el.style.maxHeight = el.scrollHeight + 'px';
    el.addEventListener('transitionend', () => { el.style.maxHeight = ''; }, { once: true });
  } else {
    el.style.maxHeight = el.scrollHeight + 'px';
    requestAnimationFrame(() => { el.style.maxHeight = '0'; el.classList.add('collapsed'); });
  }
}

function toggleMetric(id) {
  const card = document.getElementById('mc-' + id);
  if (!card) return;
  const wrap = card.querySelector('.metric-card-accounts-wrap');
  const chevron = card.querySelector('.metric-chevron');
  const opening = wrap.classList.contains('collapsed');
  wrap.classList.toggle('collapsed', !opening);
  chevron.style.transform = opening ? 'rotate(180deg)' : '';
}

function toggleSettings() {
  settingsOpen = !settingsOpen;
  const body = document.getElementById('settings-body');
  animateToggle(body, settingsOpen);
  document.getElementById('settings-chevron').style.transform = settingsOpen ? 'rotate(180deg)' : '';
  document.getElementById('settings-toggle').setAttribute('aria-expanded', settingsOpen);
}

function saveSettings() {
  const name = document.getElementById('card-name-inp').value.trim() || 'Mastercard';
  const day = Math.min(31, Math.max(1, parseInt(document.getElementById('close-day-inp').value) || 25));
  const dueDay = Math.min(31, Math.max(1, parseInt(document.getElementById('due-day-inp').value) || 5));
  appData.config.cardName = name;
  appData.config.closeDay = day;
  appData.config.dueDay = dueDay;
  toggleSettings();
  scheduleSave();
  checkAndGenerateCardDebit();
  updateCardBanner();
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
  const active = getActiveAccounts();
  curAccount = active[0].id;
  document.getElementById('account-select').value = curAccount;
}

function addTx() {
  const desc = document.getElementById('desc-inp').value.trim();
  const amount = parseFloat(document.getElementById('amount-inp').value);
  const date = document.getElementById('date-inp').value;
  if (!desc || isNaN(amount) || amount <= 0 || !date) { toast('Completá descripción, monto y fecha'); return; }
  const payMethod = curType === 'expense' ? curPay : 'income';
  const active = getActiveAccounts();
  let txAccount;
  if (active.length === 1) {
    txAccount = active[0].id;
  } else if (curType === 'income') {
    const nonPrimary = active.find(a => !PROTECTED_ACCOUNTS.includes(a.id));
    txAccount = nonPrimary ? nonPrimary.id : active[0].id;
  } else if (curPay === 'card') {
    txAccount = 'fixed';
  } else {
    txAccount = active.some(a => a.id === curAccount) ? curAccount : active[0].id;
  }
  const tx = { id: Date.now(), type: curType, payMethod, desc, amount, date, account: txAccount };
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
  const activeIds = new Set(getActiveAccounts().map(a => a.id));
  const mtx = txs.filter(t => t.date && t.date.startsWith(key) && activeIds.has(t.account));
  const income = mtx.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const cashExp = mtx.filter(t => t.type === 'expense' && t.payMethod === 'cash').reduce((s, t) => s + t.amount, 0);
  const cardAcc = mtx.filter(t => t.type === 'expense' && t.payMethod === 'card').reduce((s, t) => s + t.amount, 0);
  // Pago de tarjeta ya debitado este mes (plata real, parte de cashExp)
  const cardPaid = mtx.filter(t => t.source === 'card-debit').reduce((s, t) => s + t.amount, 0);

  // Si ya existe un card-debit para este mes, el cardImpact es 0 (ya se contabilizó en cashExp)
  const hasCardDebit = mtx.some(t => t.source === 'card-debit');
  let cardImpact = 0;
  let cardImpactNew = 0;
  let cardImpactPrev = 0;
  if (!hasCardDebit) {
    txs.forEach(t => {
      if (t.payMethod !== 'card' || !activeIds.has(t.account)) return;
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
  }
  return { income, cashExp, cardAcc, cardImpact, cardImpactNew, cardImpactPrev, cardPaid, balance: income - cashExp, monthTx: mtx };
}

function getAccountStats(y, m, accountId) {
  const key = mkey(y, m), txs = appData.transactions;
  const atx = txs.filter(t => t.account === accountId);
  const mtx = atx.filter(t => t.date && t.date.startsWith(key));
  const income = mtx.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const cashExp = mtx.filter(t => t.type === 'expense' && t.payMethod === 'cash').reduce((s, t) => s + t.amount, 0);

  // Si ya se debitó este mes, cardImpact = 0 (ya está en cashExp via card-debit)
  const hasCardDebit = mtx.some(t => t.source === 'card-debit');

  let nm = m + 1, ny = y;
  if (nm > 11) { nm = 0; ny++; }
  const nextKey = mkey(ny, nm);

  let curSingle = 0, curInstallments = 0;
  let nextSingle = 0, nextInstallments = 0;

  if (!hasCardDebit) {
    atx.forEach(t => {
      if (t.payMethod !== 'card') return;
      const isMulti = (t.installments || 1) > 1;
      const amt = isMulti ? (t.installmentAmount || Math.round(t.amount / t.installments)) : t.amount;
      if (t.impactKeys) {
        if (t.impactKeys.indexOf(key) !== -1) {
          if (isMulti) curInstallments += amt; else curSingle += amt;
        }
      } else {
        const ik = t.impactKey || '';
        if (ik === key) { if (isMulti) curInstallments += amt; else curSingle += amt; }
      }
    });
  }

  // Próximo cierre siempre se calcula (no depende del debit del mes actual)
  atx.forEach(t => {
    if (t.payMethod !== 'card') return;
    const isMulti = (t.installments || 1) > 1;
    const amt = isMulti ? (t.installmentAmount || Math.round(t.amount / t.installments)) : t.amount;
    if (t.impactKeys) {
      if (t.impactKeys.indexOf(nextKey) !== -1) {
        if (isMulti) nextInstallments += amt; else nextSingle += amt;
      }
    } else {
      const ik = t.impactKey || '';
      if (ik === nextKey) { if (isMulti) nextInstallments += amt; else nextSingle += amt; }
    }
  });

  const cardImpact = curSingle + curInstallments;
  const cardNextImpact = nextSingle + nextInstallments;

  const cardPaid = mtx.filter(t => t.source === 'card-debit').reduce((s, t) => s + t.amount, 0);

  return {
    income, cashExp, cardPaid, cardImpact, cardNextImpact,
    curSingle, curInstallments, nextSingle, nextInstallments,
    balance: income - cashExp
  };
}

// ── RENDER ────────────────────────────────────────────────────────

function render() {
  const cfg = appData.config;
  document.getElementById('month-lbl').textContent = MONTHS[curM] + ' ' + curY;
  renderAccountSelect();
  const { income, cashExp, cardPaid, balance, monthTx } = getStats(curY, curM);

  const activeAccounts = getActiveAccounts();
  const accStats = activeAccounts.map(acc => ({ ...acc, st: getAccountStats(curY, curM, acc.id) }));

  function metricCard(id, icon, label, colorClass, total, accBreakdown, annotation, subValue, leadLabel) {
    const sign = total < 0 ? '-' : '';
    const valClass = colorClass || (total >= 0 ? 'pos' : 'neg');
    const hasDetail = accBreakdown.trim().length > 0;
    const chevronHtml = hasDetail ? '<i class="ti ti-chevron-down metric-chevron" aria-hidden="true"></i>' : '';
    const clickAttr = hasDetail ? ` onclick="toggleMetric('${id}')"` : '';
    const wrapHtml = hasDetail
      ? `<div class="metric-card-accounts-wrap collapsed"><div class="metric-card-accounts">${accBreakdown}</div></div>`
      : '';
    const subHtml = subValue ? `<div class="metric-card-sub">${subValue}</div>` : '';
    const leadHtml = leadLabel ? `<span class="metric-card-sub-label">${leadLabel}</span> ` : '';
    return `<div class="metric-card" id="mc-${id}"${clickAttr}>
      <div class="metric-card-top">
        <div class="metric-card-label"><i class="ti ti-${icon} ${colorClass}" aria-hidden="true"></i>${label}</div>
        ${chevronHtml}
      </div>
      <div class="metric-card-total ${valClass}">${leadHtml}${sign}${fmt(total)}${annotation ? ` <span class="metric-card-note">${annotation}</span>` : ''}</div>
      ${subHtml}
      ${wrapHtml}
    </div>`;
  }

  function accCols(colorClass, valueFn) {
    if (accStats.length <= 1) return '';
    return accStats.map(a => {
      const val = valueFn(a.st);
      const cls = colorClass || (val >= 0 ? 'pos' : 'neg');
      return `<div class="metric-acc-row">
        <span class="metric-acc-name"><span class="acc-dot" style="background:${a.color || '#8B8B87'}"></span>${esc(a.name)}</span>
        <span class="metric-acc-value ${cls}">${val < 0 ? '-' : ''}${fmt(val)}</span>
      </div>`;
    }).join('');
  }

  let metricsHtml = '';
  metricsHtml += metricCard('income', 'arrow-down-circle', 'Ingresos', 'green', income, accCols('green', s => s.income));
  // Gastos = plata real (contado + pagos de tarjeta debitados). Desglose: contado vs tarjeta y por cuenta.
  const contadoTotal = cashExp - cardPaid;
  let expBreakdown = '';
  if (cardPaid > 0) {
    expBreakdown += `<div class="metric-acc-row"><span class="metric-acc-name"><i class="ti ti-cash" aria-hidden="true"></i>Contado</span><span class="metric-acc-value red">${fmt(contadoTotal)}</span></div>`;
    expBreakdown += `<div class="metric-acc-row"><span class="metric-acc-name"><i class="ti ti-credit-card" aria-hidden="true"></i>Tarjeta (pago)</span><span class="metric-acc-value red">${fmt(cardPaid)}</span></div>`;
  }
  expBreakdown += accCols('red', s => s.cashExp);
  metricsHtml += metricCard('expense', 'cash', 'Gastos', 'red', cashExp, expBreakdown);

  // Tarjeta: ciclo vigente (lo que se acumula hacia el próximo cierre, relativo a hoy)
  const todayStr = new Date().toISOString().split('T')[0];
  const cycleKey = computeImpactKey(todayStr, cfg.closeDay);
  const activeIdsSet = new Set(activeAccounts.map(a => a.id));
  let cycleSingle = 0, cycleInst = 0;
  appData.transactions.forEach(t => {
    if (t.payMethod !== 'card' || !activeIdsSet.has(t.account)) return;
    const isMulti = (t.installments || 1) > 1;
    const amt = isMulti ? (t.installmentAmount || Math.round(t.amount / t.installments)) : t.amount;
    const keys = t.impactKeys || (t.impactKey ? [t.impactKey] : []);
    if (keys.indexOf(cycleKey) !== -1) {
      if (isMulti) cycleInst += amt; else cycleSingle += amt;
    }
  });
  const cycleTotal = cycleSingle + cycleInst;
  if (cycleTotal > 0) {
    let creditRows = '';
    if (cycleSingle > 0) creditRows += `<div class="metric-acc-row"><span class="metric-acc-name"><i class="ti ti-receipt" aria-hidden="true"></i>Consumos</span><span class="metric-acc-value blue">${fmt(cycleSingle)}</span></div>`;
    if (cycleInst > 0) creditRows += `<div class="metric-acc-row"><span class="metric-acc-name"><i class="ti ti-calendar-repeat" aria-hidden="true"></i>Cuotas</span><span class="metric-acc-value blue">${fmt(cycleInst)}</span></div>`;
    const showDetail = cycleSingle > 0 && cycleInst > 0;
    const cd = nextCloseDateObj();
    const closeLbl = String(cd.getDate()).padStart(2, '0') + '/' + String(cd.getMonth() + 1).padStart(2, '0');
    metricsHtml += metricCard('credit', 'credit-card', 'Tarjeta', 'blue', cycleTotal, showDetail ? creditRows : '', `cierra ${closeLbl}`);
  }

  // Saldo: principal = saldo del mes; secundario = saldo total acumulado hasta el mes actual
  let saldoTotal = 0;
  const activeIds = new Set(activeAccounts.map(a => a.id));
  const allDates = appData.transactions.filter(t => t.date && activeIds.has(t.account)).map(t => t.date.slice(0, 7));
  if (allDates.length) {
    const firstKey = allDates.sort()[0];
    const [fy, fm] = firstKey.split('-').map(Number);
    let sy = fy, sm = fm - 1;
    while (sy < curY || (sy === curY && sm <= curM)) {
      const st = getStats(sy, sm);
      saldoTotal += st.balance;
      sm++;
      if (sm > 11) { sm = 0; sy++; }
    }
  }
  const saldoTotalSub = `<span class="metric-card-sub-label">Histórico</span> <span class="${saldoTotal >= 0 ? 'pos' : 'neg'}">${saldoTotal < 0 ? '-' : ''}${fmt(saldoTotal)}</span>`;
  metricsHtml += metricCard('saldo', 'wallet', 'Saldo', '', balance, '', '', saldoTotalSub, 'del mes');

  document.getElementById('metrics-grid').innerHTML = metricsHtml;
  document.getElementById('credit-card-detail').classList.add('hidden');

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
      } else if (t.source === 'card-debit') {
        sub = 'Débito automático';
      } else {
        sub = t.type === 'income' ? 'Ingreso' : 'Contado';
      }
      const accName = getAccountName(t.account);
      if (accName) sub += ' · ' + accName;
      const isAutoTx = t.source === 'rent' || t.source === 'card-debit';
      const delBtn = isAutoTx ? '' : `<button class="tx-del" onclick="deleteTx(${t.id})" aria-label="Eliminar movimiento"><i class="ti ti-x" aria-hidden="true"></i></button>`;
      return `<div class="tx-item">
        <span class="tx-dot ${dc}" aria-hidden="true"></span>
        <div class="tx-main">
          <div class="tx-desc">${esc(t.desc)}</div>
          <div class="tx-sub">${fmtDate(t.date)} · ${sub}</div>
        </div>
        <div class="tx-right">
          <span class="tx-amount ${dc}">${prefix}${fmt(t.amount)}</span>
          ${delBtn}
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
  const opening = d.classList.contains('collapsed');
  animateToggle(d, opening);
  b.innerHTML = opening
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

  let pills = sortedKeys.map(k => {
    const d = monthMap[k];
    const [y, m] = k.split('-').map(Number);
    const mName = MONTHS[m - 1].slice(0, 3);
    const finBadge = d.finishes > 0
      ? `<span class="mp-fin">${d.finishes}</span>`
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
  for (let i = 0; i <= 5; i++) { let m = curM - i, y = curY; while (m < 0) { m += 12; y--; } months.push({ y, m }); }
  const cur = mkey(curY, curM);
  document.getElementById('hist-row').innerHTML = months.map(({ y, m }) => {
    const k = mkey(y, m);
    const { income, cashExp, balance } = getStats(y, m);
    return `<div class="hist-card${k === cur ? ' active' : ''}" onclick="goMonth(${y},${m})">
      <div class="hist-month">${MONTHS[m].slice(0, 3)} ${y}</div>
      <div class="hist-nums">
        <span class="hist-income">+${fmt(income)}</span>
        <span class="hist-expense">-${fmt(cashExp)}</span>
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
                    source: 'rent',
                    account: 'fixed'
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

// ── DÉBITO AUTOMÁTICO DE TARJETA ─────────────────────────────────

async function checkAndGenerateCardDebit() {
  const dueDay = appData.config.dueDay;
  const closeDay = appData.config.closeDay;
  const cardName = appData.config.cardName || 'Mastercard';
  if (!dueDay || !closeDay) return;

  const today = new Date();
  const todayKey = today.toISOString().split('T')[0];
  const activeIds = new Set(getActiveAccounts().map(a => a.id));
  let updated = false;

  // Revisar los últimos 3 meses para generación retroactiva
  for (let offset = -2; offset <= 0; offset++) {
    let checkY = today.getFullYear(), checkM = today.getMonth() + offset;
    while (checkM < 0) { checkM += 12; checkY--; }
    while (checkM > 11) { checkM -= 12; checkY++; }

    const monthKey = mkey(checkY, checkM);
    const maxDay = new Date(checkY, checkM + 1, 0).getDate();
    const actualDueDay = Math.min(dueDay, maxDay);
    const dueDate = `${monthKey}-${String(actualDueDay).padStart(2, '0')}`;

    // Solo generar si la fecha de vencimiento ya pasó
    if (dueDate > todayKey) continue;

    // Verificar si ya existe un card-debit para este mes
    const exists = appData.transactions.find(t => t.source === 'card-debit' && t.date && t.date.startsWith(monthKey));
    if (exists) continue;

    // Calcular cardImpact para este mes (lo que se debita)
    const key = monthKey;
    let debitAmount = 0;
    appData.transactions.forEach(t => {
      if (t.payMethod !== 'card' || !activeIds.has(t.account)) return;
      if (t.impactKeys) {
        if (t.impactKeys.indexOf(key) !== -1) {
          debitAmount += t.installmentAmount || Math.round(t.amount / (t.installments || 1));
        }
      } else if (t.impactKey === key) {
        debitAmount += t.amount;
      }
    });

    if (debitAmount <= 0) continue;

    const newTx = {
      id: Date.now() + Math.random(),
      type: 'expense',
      payMethod: 'cash',
      desc: 'Pago tarjeta ' + cardName,
      amount: debitAmount,
      date: dueDate,
      source: 'card-debit',
      account: 'fixed',
      debitCycle: monthKey
    };
    appData.transactions.push(newTx);
    updated = true;
  }

  if (updated) {
    appData.transactions.sort((a, b) => b.date.localeCompare(a.date));
    await scheduleSave();
    render();
  }
}

function getCardImpactForMonth(y, m) {
  const key = mkey(y, m);
  const activeIds = new Set(getActiveAccounts().map(a => a.id));
  let total = 0;
  appData.transactions.forEach(t => {
    if (t.payMethod !== 'card' || !activeIds.has(t.account)) return;
    if (t.impactKeys) {
      if (t.impactKeys.indexOf(key) !== -1) {
        total += t.installmentAmount || Math.round(t.amount / (t.installments || 1));
      }
    } else if (t.impactKey === key) {
      total += t.amount;
    }
  });
  return total;
}

// Fecha del próximo cierre (ciclo vigente) relativa a hoy
function nextCloseDateObj() {
  const closeDay = appData.config.closeDay;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let y = today.getFullYear(), m = today.getMonth();
  const clampDay = (yy, mm) => Math.min(closeDay, new Date(yy, mm + 1, 0).getDate());
  let day = clampDay(y, m);
  if (today.getDate() > day) {
    m++; if (m > 11) { m = 0; y++; }
    day = clampDay(y, m);
  }
  return new Date(y, m, day);
}

// Ciclo cerrado pendiente de pago: el cierre ya pasó pero el vencimiento todavía no.
// Devuelve su mes de pago (impactKey) y la fecha de vencimiento, o null si no hay.
function closedPendingCycle() {
  const closeDay = appData.config.closeDay, dueDay = appData.config.dueDay;
  if (!closeDay || !dueDay) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const clampDay = (yy, mm, d) => Math.min(d, new Date(yy, mm + 1, 0).getDate());
  let cy = today.getFullYear(), cm = today.getMonth();
  const closeThis = new Date(cy, cm, clampDay(cy, cm, closeDay));
  // El cierre del mes en curso solo cuenta como "ya cerrado" a partir del día siguiente,
  // para que el día exacto del cierre el monto siga en "Próximo cierre" y no se duplique en el banner.
  if (closeThis >= today) { cm -= 1; if (cm < 0) { cm = 11; cy -= 1; } }
  // El pago cae el mes siguiente al cierre
  let py = cy, pm = cm + 1; if (pm > 11) { pm = 0; py += 1; }
  const dueDate = new Date(py, pm, clampDay(py, pm, dueDay));
  if (today > dueDate) return null;
  return { payKey: mkey(py, pm), dueDate };
}

function updateCardBanner() {
  const banner = document.getElementById('card-banner');
  const { closeDay, dueDay } = appData.config;
  if (!closeDay || !dueDay) return banner.classList.add('hidden');

  const cyc = closedPendingCycle();
  if (!cyc) return banner.classList.add('hidden');

  // Si este ciclo ya se debitó, no mostrar
  const alreadyDebited = appData.transactions.find(t => t.source === 'card-debit' && t.date && t.date.startsWith(cyc.payKey));
  if (alreadyDebited) return banner.classList.add('hidden');

  const [py, pm] = cyc.payKey.split('-').map(Number);
  const amount = getCardImpactForMonth(py, pm - 1);
  if (amount <= 0) return banner.classList.add('hidden');

  const dd = String(cyc.dueDate.getDate()).padStart(2, '0');
  const mm = String(cyc.dueDate.getMonth() + 1).padStart(2, '0');
  const cardName = appData.config.cardName || 'Mastercard';
  document.getElementById('card-banner-text').innerHTML =
    `<b>A pagar (vence ${dd}/${mm}):</b> Se debitarán ${fmt(amount)} de ${cardName}`;
  banner.classList.remove('hidden');
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

// Horizontal scroll: wheel + drag (desktop)
const DRAG_SELECTOR = '.scroll-row, .hist-row';
document.addEventListener('wheel', e => {
  const row = e.target.closest(DRAG_SELECTOR);
  if (!row) return;
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault();
    row.scrollLeft += e.deltaY;
  }
}, { passive: false });

(function initDragScroll() {
  let dragEl = null, startX = 0, startScroll = 0, dragged = false;
  document.addEventListener('mousedown', e => {
    const row = e.target.closest(DRAG_SELECTOR);
    if (!row || e.button !== 0) return;
    dragEl = row;
    startX = e.pageX;
    startScroll = row.scrollLeft;
    dragged = false;
    row.style.cursor = 'grabbing';
    row.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragEl) return;
    const dx = e.pageX - startX;
    if (Math.abs(dx) > 3) dragged = true;
    dragEl.scrollLeft = startScroll - dx;
  });
  document.addEventListener('mouseup', () => {
    if (!dragEl) return;
    dragEl.style.cursor = '';
    dragEl.style.userSelect = '';
    if (dragged) setTimeout(() => { dragged = false; }, 0);
    dragEl = null;
  });
  // Prevent click on hist-cards when dragging
  document.addEventListener('click', e => {
    if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; }
  }, true);
})();

init();
