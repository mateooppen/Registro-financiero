const CLIENT_ID = '926576243590-0ffu3hgsn4qmsdua6bekbb0s7443j2cn.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const REDIRECT_URI = window.location.origin + window.location.pathname;
const FILE_NAME = 'finanzas_data.json';
const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

let accessToken = null;
let tokenExpiry = 0;
let driveFileId = null;
let appData = { transactions: [], config: { closeDay: 25, cardName: 'Tarjeta' } };
let curY, curM;
let curType = 'expense', curPay = 'cash';
let settingsOpen = false;
let rentSettingsOpen = false;
let saveTimer = null;

// --- AUTHENTICATION ---

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
  sessionStorage.setItem('fp_token', JSON.stringify({ token, expiry: tokenExpiry }));
}

function loadTokenFromSession() {
  try {
    const raw = sessionStorage.getItem('fp_token');
    if (!raw) return false;
    const { token, expiry } = JSON.parse(raw);
    if (Date.now() > expiry - 60000) return false;
    accessToken = token;
    tokenExpiry = expiry;
    return true;
  } catch { return false; }
}

function signOut() {
  if (!confirm('¿Cerrar sesión?')) return;
  sessionStorage.clear();
  window.location.reload();
}

// --- DRIVE API ---

async function driveReq(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + accessToken, ...(opts.headers || {}) }
  });
  if (res.status === 401) { signOut(); throw new Error('unauthorized'); }
  return res;
}

async function loadOrCreateFile() {
  const res = await driveReq(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name%3D%22${FILE_NAME}%22&fields=files(id)`);
  const data = await res.json();
  if (data.files && data.files.length > 0) {
    driveFileId = data.files[0].id;
    const fileRes = await driveReq(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`);
    const json = await fileRes.json();
    appData = { ...appData, ...json };
  } else {
    await createFile();
  }
}

async function createFile() {
  const meta = { name: FILE_NAME, parents: ['appDataFolder'] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', new Blob([JSON.stringify(appData)], { type: 'application/json' }));
  const res = await driveReq('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: form });
  const d = await res.json();
  driveFileId = d.id;
}

async function saveToDrive() {
  if (!driveFileId) return;
  showSaveBar('Guardando...');
  await driveReq(`https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(appData)
  });
  showSaveBar('Guardado', true);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToDrive, 1500);
}

// --- UI LOGIC ---

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
}

function toggleSettings() {
  settingsOpen = !settingsOpen;
  document.getElementById('settings-body').classList.toggle('hidden', !settingsOpen);
  document.getElementById('settings-chevron').style.transform = settingsOpen ? 'rotate(180deg)' : '';
}

function toggleRentSettings() {
  rentSettingsOpen = !rentSettingsOpen;
  document.getElementById('rent-body').classList.toggle('hidden', !rentSettingsOpen);
  document.getElementById('rent-chevron').style.transform = rentSettingsOpen ? 'rotate(180deg)' : '';
}

// --- RENT LOGIC ---

function saveRentConfig() {
  const startDate = document.getElementById('rent-start-date').value;
  if (!startDate) { toast('Seleccioná una fecha de inicio'); return; }

  appData.config.rent = {
    baseAmount: parseFloat(document.getElementById('rent-base-amount').value),
    day: parseInt(document.getElementById('rent-day').value),
    startMonth: startDate.slice(0, 7),
    increaseFreq: parseInt(document.getElementById('rent-freq').value),
    percent: parseFloat(document.getElementById('rent-percent').value)
  };
  
  scheduleSave();
  toast('Configuración de alquiler guardada');
  toggleRentSettings();
  render();
}

function saveSettings() {
  appData.config.cardName = document.getElementById('card-name-inp').value || 'Tarjeta';
  appData.config.closeDay = parseInt(document.getElementById('close-day-inp').value) || 25;
  scheduleSave();
  toast('Configuración guardada');
  toggleSettings();
  render();
}

// --- CORE APP ---

function addTx() {
  const desc = document.getElementById('desc-inp').value;
  const amount = parseFloat(document.getElementById('amount-inp').value);
  const date = document.getElementById('date-inp').value;
  if (!desc || !amount || !date) { toast('Completá todos los campos'); return; }

  const tx = { id: Date.now(), type: curType, payMethod: curType === 'expense' ? curPay : 'income', desc, amount, date };
  if (tx.payMethod === 'card') {
    const inst = parseInt(document.getElementById('installments-inp').value) || 1;
    tx.installments = inst;
    tx.installmentAmount = Math.round(amount / inst);
  }
  appData.transactions.push(tx);
  document.getElementById('desc-inp').value = '';
  document.getElementById('amount-inp').value = '';
  scheduleSave();
  render();
}

function render() {
  document.getElementById('month-lbl').textContent = `${MONTHS[curM]} ${curY}`;
  // Aquí va el resto de tu lógica de render (metrics, tx-list, installments)
  // que ya tenías en el archivo original.
}

function showSaveBar(msg, success) {
  const bar = document.getElementById('save-bar');
  document.getElementById('save-bar-text').textContent = msg;
  bar.classList.remove('hidden');
  if (success) setTimeout(() => bar.classList.add('hidden'), 2000);
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// --- INIT ---

async function init() {
  const hash = location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    saveToken(params.get('access_token'), params.get('expires_in'));
    history.replaceState(null, '', location.pathname);
  }

  if (loadTokenFromSession()) {
    document.getElementById('screen-auth').classList.add('hidden');
    document.getElementById('screen-loading').classList.remove('hidden');
    await loadOrCreateFile();
    const now = new Date();
    curY = now.getFullYear(); curM = now.getMonth();
    document.getElementById('date-inp').value = now.toISOString().split('T')[0];
    
    // Cargar config de alquiler en inputs
    if (appData.config.rent) {
        const rc = appData.config.rent;
        document.getElementById('rent-base-amount').value = rc.baseAmount;
        document.getElementById('rent-day').value = rc.day;
        document.getElementById('rent-start-date').value = rc.startMonth + "-01";
        document.getElementById('rent-freq').value = rc.increaseFreq;
        document.getElementById('rent-percent').value = rc.percent;
    }

    document.getElementById('screen-loading').classList.add('hidden');
    document.getElementById('screen-app').classList.remove('hidden');
    document.getElementById('month-nav').classList.remove('hidden');
    render();
  } else {
    document.getElementById('auth-link').href = buildAuthUrl();
  }
}

init();
