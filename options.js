// options.js
// Управляет настройками расширения: список заблокированных сайтов,
// permanent-блокировка YouTube Shorts и прочие опции.
//
// Хранилище: chrome.storage.local
//   blockedSites                -> string[]  (нормализованные домены, напр. "instagram.com")
//   blockYoutubeShortsPermanent -> boolean    (блокирует ВСЕ Shorts во время фокус-сессии,
//                                               без сверки с целью; вне сессии не действует)
//   strictMode                  -> boolean    (прячет кнопку Cancel в popup.js на время сессии)
//   showNotifications           -> boolean    (уведомления от background.js при блокировке)
//   cooldownMinutes             -> number     (пауза перед стартом новой сессии в popup.js)
//
// Примечание: имена ключей подобраны так, чтобы не конфликтовать с уже
// используемыми в popup.js (dataset, goal, session-таймер и т.д.).
// Если в popup.js/background.js уже используются другие ключи для
// заблокированных сайтов — переименуйте константы ниже под них.

const STORAGE_KEYS = {
  BLOCKED_SITES: 'blockedSites',
  BLOCK_SHORTS_PERMANENT: 'blockYoutubeShortsPermanent',
  STRICT_MODE: 'strictMode',
  SHOW_NOTIFICATIONS: 'showNotifications',
  COOLDOWN_MINUTES: 'cooldownMinutes',
};

const DEFAULT_SETTINGS = {
  [STORAGE_KEYS.BLOCKED_SITES]: [],
  [STORAGE_KEYS.BLOCK_SHORTS_PERMANENT]: false,
  [STORAGE_KEYS.STRICT_MODE]: false,
  [STORAGE_KEYS.SHOW_NOTIFICATIONS]: true,
  [STORAGE_KEYS.COOLDOWN_MINUTES]: 0,
};

const PRESET_SITES = [
  'youtube.com',
  'instagram.com',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'reddit.com',
  'twitch.tv',
];

// ---- DOM refs ----
const siteInput = document.getElementById('site-input');
const addSiteBtn = document.getElementById('add-site-btn');
const siteError = document.getElementById('site-error');
const siteList = document.getElementById('site-list');
const emptyState = document.getElementById('empty-state');
const presetsContainer = document.getElementById('presets');

const blockShortsToggle = document.getElementById('block-shorts-permanent');
const strictModeToggle = document.getElementById('strict-mode');
const showNotificationsToggle = document.getElementById('show-notifications');
const cooldownInput = document.getElementById('cooldown-minutes');

const saveToast = document.getElementById('save-toast');

let state = { ...DEFAULT_SETTINGS };
let toastTimeout = null;

// ---- Storage helpers ----

function loadSettings() {
  chrome.storage.local.get(Object.values(STORAGE_KEYS), (stored) => {
    state = { ...DEFAULT_SETTINGS, ...stored };
    renderAll();
  });
}

function saveSettings(partial) {
  Object.assign(state, partial);
  chrome.storage.local.set(partial, () => {
    showToast();
  });
}

function showToast() {
  saveToast.classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    saveToast.classList.remove('visible');
  }, 1200);
}

// ---- Domain validation / normalization ----

function normalizeDomain(raw) {
  let value = raw.trim().toLowerCase();
  if (!value) return null;

  // Allow users to paste a full URL
  try {
    if (!/^[a-z]+:\/\//.test(value)) {
      value = 'https://' + value;
    }
    const url = new URL(value);
    value = url.hostname;
  } catch (e) {
    // fall through, will fail validation below
  }

  value = value.replace(/^www\./, '');

  const domainPattern = /^([a-z0-9-]+\.)+[a-z]{2,}$/i;
  if (!domainPattern.test(value)) return null;

  return value;
}

// ---- Rendering ----

function renderAll() {
  renderSiteList();
  renderPresets();
  blockShortsToggle.checked = !!state[STORAGE_KEYS.BLOCK_SHORTS_PERMANENT];
  strictModeToggle.checked = !!state[STORAGE_KEYS.STRICT_MODE];
  showNotificationsToggle.checked = !!state[STORAGE_KEYS.SHOW_NOTIFICATIONS];
  cooldownInput.value = state[STORAGE_KEYS.COOLDOWN_MINUTES] || 0;
}

function renderSiteList() {
  const sites = state[STORAGE_KEYS.BLOCKED_SITES];
  siteList.innerHTML = '';

  if (!sites.length) {
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';

  sites
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .forEach((domain) => {
      const row = document.createElement('div');
      row.className = 'site-row';

      const label = document.createElement('span');
      label.className = 'site-domain';
      label.textContent = domain;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.title = 'Удалить';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => removeSite(domain));

      row.appendChild(label);
      row.appendChild(removeBtn);
      siteList.appendChild(row);
    });
}

function renderPresets() {
  const sites = new Set(state[STORAGE_KEYS.BLOCKED_SITES]);
  presetsContainer.innerHTML = '';

  PRESET_SITES.filter((domain) => !sites.has(domain)).forEach((domain) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'preset-chip';
    chip.textContent = '+ ' + domain;
    chip.addEventListener('click', () => addSite(domain));
    presetsContainer.appendChild(chip);
  });
}

// ---- Site list mutations ----

function addSite(rawValue) {
  const domain = normalizeDomain(rawValue);

  if (!domain) {
    siteError.style.display = 'block';
    siteInput.classList.add('invalid');
    return;
  }

  siteError.style.display = 'none';
  siteInput.classList.remove('invalid');

  const sites = state[STORAGE_KEYS.BLOCKED_SITES];
  if (sites.includes(domain)) {
    siteInput.value = '';
    return;
  }

  const updated = [...sites, domain];
  saveSettings({ [STORAGE_KEYS.BLOCKED_SITES]: updated });
  renderSiteList();
  renderPresets();
  siteInput.value = '';
  siteInput.focus();
}

function removeSite(domain) {
  const updated = state[STORAGE_KEYS.BLOCKED_SITES].filter((d) => d !== domain);
  saveSettings({ [STORAGE_KEYS.BLOCKED_SITES]: updated });
  renderSiteList();
  renderPresets();
}

// ---- Event listeners ----

addSiteBtn.addEventListener('click', () => addSite(siteInput.value));

siteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addSite(siteInput.value);
  }
});

siteInput.addEventListener('input', () => {
  siteError.style.display = 'none';
  siteInput.classList.remove('invalid');
});

blockShortsToggle.addEventListener('change', () => {
  saveSettings({ [STORAGE_KEYS.BLOCK_SHORTS_PERMANENT]: blockShortsToggle.checked });
});

strictModeToggle.addEventListener('change', () => {
  saveSettings({ [STORAGE_KEYS.STRICT_MODE]: strictModeToggle.checked });
});

showNotificationsToggle.addEventListener('change', () => {
  saveSettings({ [STORAGE_KEYS.SHOW_NOTIFICATIONS]: showNotificationsToggle.checked });
});

cooldownInput.addEventListener('change', () => {
  let value = parseInt(cooldownInput.value, 10);
  if (isNaN(value) || value < 0) value = 0;
  if (value > 60) value = 60;
  cooldownInput.value = value;
  saveSettings({ [STORAGE_KEYS.COOLDOWN_MINUTES]: value });
});

// ---- Init ----

document.addEventListener('DOMContentLoaded', loadSettings);