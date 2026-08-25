// Focus Goal Assistant — popup logic (chatbot removed, goal picked via select)

const goalSelect = document.getElementById('goal-select');
const goalCustomInput = document.getElementById('goal-custom-input');
const timeInput = document.getElementById('time-input');
const startBtn = document.getElementById('start-btn');
const cancelBtn = document.getElementById('cancel-btn');
const timeLabel = document.getElementById('remaining-time');
const loginBtn = document.getElementById('google-login-btn');
const settingsBtn = document.getElementById('settings-btn');

// Server configuration
const SERVER_URL = 'http://localhost:8000/user';
// const CHAT_ENDPOINT = `${SERVER_URL}/chat`;        // SERVER: закомментировано
// const SITE_SEND_POINT = `${SERVER_URL}/parseSite`; // SERVER: закомментировано

let focusGoal = '';
let isUserFocused = false;
let endTimestamp = 0;
let cooldownActive = false;
let strictModeEnabled = false;

// ── Goal selection ───────────────────────────────────────────
function updateGoalFromInputs() {
  if (goalSelect.value === 'custom') {
    goalCustomInput.classList.remove('hidden');
    focusGoal = goalCustomInput.value.trim();
  } else {
    goalCustomInput.classList.add('hidden');
    focusGoal = goalSelect.value || '';
  }
  updateStartButtonState();
}

goalSelect.addEventListener('change', updateGoalFromInputs);
goalCustomInput.addEventListener('input', updateGoalFromInputs);

function resetGoalSelection() {
  goalSelect.selectedIndex = 0;
  goalCustomInput.value = '';
  goalCustomInput.classList.add('hidden');
  focusGoal = '';
  updateStartButtonState();
}

// ── Helpers ───────────────────────────────────────────────────
function validateTime() {
  const time = parseInt(timeInput.value);
  if (isNaN(time) || time < 1 || time > 480) { timeInput.classList.add('invalid'); return false; }
  timeInput.classList.remove('invalid'); return true;
}

function updateStartButtonState() {
  startBtn.disabled = !(focusGoal.trim() && validateTime()) || cooldownActive;
}

function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
}

// ── Focus session ─────────────────────────────────────────────
async function startFocusSession() {
  const time = parseInt(timeInput.value);
  if (!validateTime() || !focusGoal.trim()) return;

  const cooldownRemainingMs = await getCooldownRemainingMs();
  if (cooldownRemainingMs > 0) {
    showCooldownMessage(cooldownRemainingMs);
    return;
  }

  endTimestamp = Date.now() + time * 60 * 1000;
  const focusData = { focusGoal, endTime: endTimestamp, enabled: true };

  await chrome.storage.local.set({ 'focusSession': focusData });
  showView('focus-view');
  endTimestamp = Date.now() + time * 60 * 1000;
  isUserFocused = true;
  timeLabel.textContent = `${time} минут`;
  // window.close();
}

function showFocusView(endTime) {
  showView('focus-view');
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    const urlLabel = document.getElementById('current-url-label');
    if (urlLabel && tab?.url) urlLabel.textContent = tab.url;
  });
  const remainingMs = endTime - Date.now();
  if (remainingMs < 0) { endFocusSession(); }
  else {
    const minutes = Math.floor(Math.max(remainingMs, 0) / 1000 / 60);
    timeLabel.textContent = `${minutes} минут`;
  }
}

async function endFocusSession() {
  isUserFocused = false;
  await chrome.storage.local.set({
    focusSession: { focusGoal: null, endTime: null, enabled: false },
    lastSessionEndTime: Date.now(),
  });
  resetGoalSelection();
  showView('main-view');
  updateCooldownUI();
  // window.close();
}

// ── Cooldown между сессиями ─────────────────────────────────────────
function getCooldownMessageEl() {
  let el = document.getElementById('cooldown-message');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cooldown-message';
    el.style.marginTop = '6px';
    el.style.fontSize = '11px';
    el.style.color = '#dc3545';
    el.style.textAlign = 'center';
    el.style.display = 'none';
    startBtn.insertAdjacentElement('afterend', el);
  }
  return el;
}

async function getCooldownRemainingMs() {
  const data = await chrome.storage.local.get(['cooldownMinutes', 'lastSessionEndTime']);
  const cooldownMinutes = data.cooldownMinutes || 0;
  const lastEnd = data.lastSessionEndTime || 0;
  if (!cooldownMinutes || !lastEnd) return 0;
  const requiredMs = cooldownMinutes * 60 * 1000;
  const elapsedMs = Date.now() - lastEnd;
  return Math.max(0, requiredMs - elapsedMs);
}

let cooldownInterval = null;

function showCooldownMessage(remainingMs) {
  const el = getCooldownMessageEl();
  cooldownActive = true;
  updateStartButtonState();

  clearInterval(cooldownInterval);
  let remaining = Math.ceil(remainingMs / 1000);

  const render = () => {
    if (remaining <= 0) {
      clearInterval(cooldownInterval);
      cooldownInterval = null;
      cooldownActive = false;
      el.style.display = 'none';
      updateStartButtonState();
      return;
    }
    const mm = Math.floor(remaining / 60);
    const ss = remaining % 60;
    el.textContent = `Следующую сессию можно начать через ${mm > 0 ? mm + ' мин ' : ''}${ss} сек`;
    el.style.display = 'block';
    remaining -= 1;
  };

  render();
  cooldownInterval = setInterval(render, 1000);
}

async function updateCooldownUI() {
  const remainingMs = await getCooldownRemainingMs();
  if (remainingMs > 0) {
    showCooldownMessage(remainingMs);
  } else {
    cooldownActive = false;
    const el = document.getElementById('cooldown-message');
    if (el) el.style.display = 'none';
    updateStartButtonState();
  }
}

// ── Strict mode: скрываем кнопку Cancel, пока он включён ────────────
async function applyStrictModeUI() {
  const data = await chrome.storage.local.get('strictMode');
  strictModeEnabled = !!data.strictMode;
  if (cancelBtn) {
    cancelBtn.style.display = strictModeEnabled ? 'none' : '';
  }
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== 'local') return;
  if (changes.strictMode) applyStrictModeUI();
  if (changes.cooldownMinutes && !isUserFocused) updateCooldownUI();
});

// ── Server health check ─────────────────────────────────────────
// Проверяем доступность сервера один раз при открытии popup.
// Если сервер не отвечает — AI-проверку сайта вообще не запускаем.
let isServerHealthy = false;
let serverHealthChecked = false;

async function checkServerHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(`${SERVER_URL}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    isServerHealthy = resp.ok;
  } catch (err) {
    isServerHealthy = false;
  }
  serverHealthChecked = true;
  console.log(`[Server Health] ${isServerHealthy ? 'Сервер доступен' : 'Сервер недоступен'}`);
  return isServerHealthy;
}

// ── onPopupOpen ───────────────────────────────────────────────
async function onPopupOpen() {
  const session = await chrome.storage.local.get('access_token');

  // Проверка сервера не блокирует открытие popup — просто запускаем
  // её в фоне, результат используется позже при клике "Просмотр сайта".
  checkServerHealth();

  // ── SERVER: checkSite при открытии ──────────────────────────
  // ...закомментировано...
  // ── END SERVER ───────────────────────────────────────────────

  session.access_token = 'so_much_token_for_testing_purposes';

  if (!session.access_token) {
    showView('login-view');
    return;
  }

  applyStrictModeUI();

  const stored = await chrome.storage.local.get('focusSession');
  if (stored.focusSession && stored.focusSession['enabled'] === true) {
    endTimestamp = stored.focusSession['endTime'];
    focusGoal = stored.focusSession['focusGoal'] || '';
    isUserFocused = true;
    showFocusView(endTimestamp);
  } else {
    isUserFocused = false;
    showView('main-view');
    updateCooldownUI();
  }
}

// ── Login ─────────────────────────────────────────────────────
loginBtn.addEventListener('click', () => {
  // ── SERVER: Google OAuth ─────────────────────────────────────
  // chrome.runtime.sendMessage({ type: "GOOGLE_LOGIN" });
  // ── END SERVER ───────────────────────────────────────────────
  onPopupOpen();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOGIN_SUCCESS') onPopupOpen();
});

// ── Settings ──────────────────────────────────────────────────
settingsBtn?.addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('options.html'));
  }
});

// ── Check Site ────────────────────────────────────────────────
const checkSiteBtn       = document.getElementById('check-site-btn');
const checkSiteInput     = document.getElementById('check-site-input');
const checkSiteResult    = document.getElementById('check-site-result');

checkSiteBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab?.url || '').trim();
  if (!url) return;

  checkSiteInput.value = url;
  const urlLabel = document.getElementById('current-url-label');
  if (urlLabel) urlLabel.textContent = url;

  checkSiteResult.style.display = 'none';

  // ── AI-классификация сайта (реальный запрос к серверу) ────────
  // НЕ ждём ответа сервера — ответ модели (если придёт) просто
  // подставится в свой блок позже, когда будет готов.
  // Если сервер недоступен (health-check не прошёл) — запрос
  // вообще не отправляется.
  requestAiSiteCheck(url);
  // ── END AI-классификация ───────────────────────────────────────
});

// ── AI check: блок для вывода ответа сервера (модель) ──────────
// Элемент создаётся динамически, если его нет в popup.html —
// ничего в разметке менять не нужно.
function getAiCheckResultEl() {
  let el = document.getElementById('ai-check-result');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ai-check-result';
    el.style.marginTop = '6px';
    el.style.padding = '8px';
    el.style.borderRadius = '6px';
    el.style.fontSize = '13px';
    el.style.display = 'none';
    checkSiteResult.insertAdjacentElement('afterend', el);
  }
  return el;
}

async function requestAiSiteCheck(url) {
  // Если health-check ещё не завершился (например, сервер стартовал
  // прямо перед кликом) — на всякий случай ждём его буквально момент.
  if (!serverHealthChecked) {
    await checkServerHealth();
  }

  // Сервер недоступен — просто ничего не делаем, никакого блока
  // с AI-ответом не показываем.
  if (!isServerHealthy) {
    console.log('[AI Check] Сервер недоступен, AI-проверка пропущена');
    return;
  }

  const aiResultEl = getAiCheckResultEl();
  aiResultEl.style.display = 'block';
  aiResultEl.style.background = '#e2e3e5';
  aiResultEl.style.color = '#383d41';
  aiResultEl.textContent = '🤖 Запрашиваю сервер...';

  try {
    const body = {
      url,
      goal: focusGoal || '',
    };

    // Таймаут 2 минуты — модель на слабом железе может думать долго.
    // Не блокирует пользователя: запрос идёт в фоне, UI ждать не нужно.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    const resp = await fetch(`${SERVER_URL}/checkSite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!resp.ok) throw new Error(`Status ${resp.status}`);

    const data = await resp.json();
    console.log('[AI Check] Ответ сервера:', data);

    // Пытаемся распознать вердикт в разных возможных форматах ответа
    const rawVerdict = data.decision ?? data.verdict ?? data.label ?? data.result ?? null;
    const verdictStr = (rawVerdict ?? '').toString().toLowerCase();

    let isAllowed = null;
    if (verdictStr.includes('allow') || verdictStr.includes('разреш')) isAllowed = true;
    else if (verdictStr.includes('den') || verdictStr.includes('block') || verdictStr.includes('запрещ')) isAllowed = false;

    if (isAllowed === true) {
      aiResultEl.textContent = `🤖 Модель: ✓ Разрешено${rawVerdict ? ` (${rawVerdict})` : ''}`;
      aiResultEl.style.background = '#d4edda';
      aiResultEl.style.color = '#155724';
    } else if (isAllowed === false) {
      aiResultEl.textContent = `🤖 Модель: ✗ Запрещено${rawVerdict ? ` (${rawVerdict})` : ''}`;
      aiResultEl.style.background = '#f8d7da';
      aiResultEl.style.color = '#721c24';
    } else {
      // Формат ответа не распознан — покажем как есть
      aiResultEl.textContent = `🤖 Ответ сервера: ${JSON.stringify(data)}`;
      aiResultEl.style.background = '#e2e3e5';
      aiResultEl.style.color = '#383d41';
    }
  } catch (err) {
    console.warn('[AI Check] Нет ответа от сервера:', err);
    aiResultEl.textContent = '🤖 Нет ответа от сервера';
    aiResultEl.style.background = '#e2e3e5';
    aiResultEl.style.color = '#6c757d';
  }
}

// ── Event listeners ───────────────────────────────────────────
timeInput.addEventListener('input', updateStartButtonState);
timeInput.addEventListener('blur', validateTime);
startBtn.addEventListener('click', startFocusSession);
cancelBtn.addEventListener('click', endFocusSession);

updateStartButtonState();
onPopupOpen();

setInterval(() => {
  if (isUserFocused) showFocusView(endTimestamp);
}, 1000);