// Импортируем Transformers.js. 
// Убедись, что библиотека лежит в папке расширения (например, в ./lib/transformers.js)
import { AutoTokenizer, AutoModelForSequenceClassification, env } from './lib/transformers.min.js';
// YOUTUBE_API_KEY больше не хранится в коде — он приходит из config.js,
// который генерируется из .env (см. scripts/generate-config.js).
import { YOUTUBE_API_KEY } from './config.js';

// 1. Отключаем кэш браузера (избегаем ошибок в Chrome Extension)
if (env.cache) {
  env.cache.enabled = false;
}
if (typeof env.useBrowserCache !== 'undefined') {
  env.useBrowserCache = false;
}
// 2. Настраиваем локальную работу
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = chrome.runtime.getURL('models/');

// 3. Отключаем проксирование воркеров (решает проблему с URL.createObjectURL)
if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
  env.backends.onnx.wasm.proxy = false; // <-- ВАЖНО: это отключит создание воркеров через Blobs
  env.backends.onnx.wasm.numThreads = 1; // Оставляем один поток
}
const DEFAULT_BLOCKED_SITES = [
];

// Используется только как запасной вариант: если "вернуться назад"
// невозможно (нет истории в этой вкладке) или если пользователь слишком
// долго подряд натыкается на заблокированные страницы в истории.
const FALLBACK_URL = 'chrome://newtab';

// Максимум подряд идущих "откатов назад" на одной вкладке, прежде чем
// сдаться и просто открыть FALLBACK_URL (защита от пинг-понга между
// двумя взаимно заблокированными страницами в истории).
const MAX_BACK_ATTEMPTS = 5;

// ── YouTube: извлечение video_id и запрос метаданных через API ─────
// Портировано 1:1 из popup.js — то же самое видел сервер при разметке
// датасета, поэтому важно, чтобы background.js собирал данные так же.
function extractYoutubeInfo(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    if (!hostname.includes('youtube.com') && !hostname.includes('youtu.be')) {
      return { is_youtube: false };
    }

    // Shorts: youtube.com/shorts/VIDEO_ID
    if (parsed.pathname.includes('/shorts/')) {
      const videoId = parsed.pathname.split('/shorts/')[1].split('/')[0];
      return { is_youtube: true, type: 'SHORTS', video_id: videoId };
    }

    // Короткая ссылка: youtu.be/VIDEO_ID
    if (hostname.includes('youtu.be')) {
      const videoId = parsed.pathname.replace('/', '');
      return { is_youtube: true, type: 'VIDEO', video_id: videoId };
    }

    // Стандартная: youtube.com/watch?v=VIDEO_ID
    if (parsed.pathname.includes('/watch')) {
      const videoId = parsed.searchParams.get('v');
      if (videoId) return { is_youtube: true, type: 'VIDEO', video_id: videoId };
    }

    // Embed и прочие форматы
    const match = url.match(/(?:v=|\/embed\/|\/v\/|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (match) return { is_youtube: true, type: 'VIDEO', video_id: match[1] };

    return { is_youtube: true, type: 'UNKNOWN', video_id: null };
  } catch (_) {
    return { is_youtube: false };
  }
}

async function fetchYoutubeData(videoId) {
  const params = new URLSearchParams({
    id: videoId,
    key: YOUTUBE_API_KEY,
    part: 'snippet',
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`, {
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`YouTube API error: ${resp.status}`);
    const json = await resp.json();
    const snippet = json?.items?.[0]?.snippet;
    if (!snippet) throw new Error('No snippet in YouTube response');
    return {
      title: snippet.title || null,
      description: snippet.description || null,
      tags: snippet.tags || [],
      channelName: snippet.channelTitle || null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Переменные для хранения токенайзера и модели в памяти
// ВАЖНО: НЕ используем pipeline('text-classification', ...) — его _call()
// принимает из options только topk и молча игнорирует text_pair, поэтому
// страница по факту никогда не попадала в модель, классифицировался только goal.
let tokenizer = null;
let model = null;
// Хранилище обработанных вкладок (tabId -> url) для предотвращения бесконечных редиректов
const checkedTabs = new Map();
// Счётчик подряд идущих "откатов назад" на вкладке (tabId -> count)
const backAttempts = new Map();
// URL, которые прямо сейчас проходят анализ (tabId -> url). Нужно, чтобы
// повторные onUpdated-события на тот же URL (частое явление на SPA вроде
// YouTube, где status:'complete' и changeInfo.url могут прилететь отдельно
// друг от друга) не запускали параллельный дублирующий анализ, пока первый
// ещё не завершился.
const inFlightChecks = new Map();

// ── Ленивая загрузка модели ──────────────────────────────────────
async function loadModel() {
  if (tokenizer && model) return { tokenizer, model };
  console.log('[Lock In Blocker] Загрузка локальной модели ');
  try {
    tokenizer = await AutoTokenizer.from_pretrained('youtube-video-relevance-classifier');
    model = await AutoModelForSequenceClassification.from_pretrained('youtube-video-relevance-classifier', { quantized: false });
    console.log('[Lock In Blocker] Локальная модель успешно загружена!');
    return { tokenizer, model };
  } catch (error) {
    console.error('[Lock In Blocker] Ошибка при загрузке модели:', error);
    tokenizer = null;
    model = null;
    return null;
  }
}

async function getClassifier() {
  if (!tokenizer || !model) {
    return await loadModel();
  }
  return { tokenizer, model };
}

function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((x) => x / sum);
}

// ── "Назад" вместо редиректа на фиксированную страницу ─────────────
// Имитирует нажатие кнопки "← Назад" в браузере: пользователь просто
// возвращается на предыдущую страницу в истории вкладки, как будто сам
// нажал (а не "удерживал", чтобы открыть список истории — сама история
// не трогается и не показывается).
async function redirectAway(tabId) {
  const attempts = (backAttempts.get(tabId) || 0) + 1;
  backAttempts.set(tabId, attempts);

  if (attempts > MAX_BACK_ATTEMPTS) {
    console.warn('[Lock In Blocker] Слишком много заблокированных страниц подряд в истории — открываем запасную страницу');
    backAttempts.delete(tabId);
    try {
      await chrome.tabs.update(tabId, { url: FALLBACK_URL });
    } catch (_) {}
    return;
  }

  // Проверяем, есть ли вообще куда возвращаться в этой вкладке —
  // chrome.tabs.goBack() молча ничего не делает, если истории нет,
  // поэтому сначала спрашиваем у самой страницы её history.length.
  let canGoBack = false;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.history.length > 1,
    });
    canGoBack = !!results?.[0]?.result;
  } catch (_) {
    canGoBack = false;
  }

  if (canGoBack) {
    try {
      await chrome.tabs.goBack(tabId);
      return;
    } catch (e) {
      console.warn('[Lock In Blocker] chrome.tabs.goBack() не сработал:', e);
    }
  }

  try {
    await chrome.tabs.update(tabId, { url: FALLBACK_URL });
  } catch (_) {}
}

// ── Уведомления о блокировке ────────────────────────────────────────
// Требует permission "notifications" в manifest.json.
function notifyBlocked(message) {
  if (!chrome.notifications) {
    console.warn('[Lock In Blocker] chrome.notifications недоступен — добавь permission "notifications" в manifest.json');
    return;
  }
  chrome.notifications.create(
    {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/128.png'),
      title: 'Фокус-сессия',
      message,
      priority: 1,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn('[Lock In Blocker] Не удалось показать уведомление:', chrome.runtime.lastError.message);
      }
    }
  );
}

// ── Слушатель клика на иконку ─────────────────────────────
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
});

// ── Инициализация при установке ───────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.get(['blockedSites'], (data) => {
      if (!Array.isArray(data.blockedSites) || data.blockedSites.length === 0) {
        chrome.storage.local.set({ blockedSites: DEFAULT_BLOCKED_SITES });
      }
    });

    chrome.storage.local.get('focusSession', (data) => {
      if (!data.focusSession) {
        chrome.storage.local.set({
          focusSession: { focusGoal: null, endTime: null, enabled: false },
        });
      }
    });
  }
});

// Очистка кэша вкладок при закрытии
chrome.tabs.onRemoved.addListener((tabId) => {
  checkedTabs.delete(tabId);
  backAttempts.delete(tabId);
  inFlightChecks.delete(tabId);
});

// ── Мониторинг старта сессии (Ловим переход false -> true) ──────
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.focusSession) {
    const oldVal = changes.focusSession.oldValue;
    const newVal = changes.focusSession.newValue;

    const wasEnabled = oldVal ? oldVal.enabled : false;
    const isEnabled = newVal ? newVal.enabled : false;

    if (!wasEnabled && isEnabled) {
      console.log('[Lock In Blocker] Фокус-сессия запущена! Инициируем предзагрузку модели...');
      loadModel();
    } else if (wasEnabled && !isEnabled) {
      console.log('[Lock In Blocker] Сессия завершена. Выгружаем модель для экономии RAM...');
      tokenizer = null;
      model = null;
      checkedTabs.clear();
      backAttempts.clear();
    }
  }
});

// ── Валидация URL под условия проверки ────────────────────────────
function normalizeDomain(domain) {
  return (domain || '').replace(/^www\./, '').toLowerCase().trim();
}

function isSiteBlocked(hostname, blockedSites) {
  const normalizedHostname = normalizeDomain(hostname);
  return blockedSites.some((site) => {
    const normalizedSite = normalizeDomain(site);
    if (!normalizedSite.includes('.')) return false;
    return (
      normalizedHostname === normalizedSite ||
      normalizedHostname.endsWith('.' + normalizedSite)
    );
  });
}

function shouldCheckUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.replace(/^www\./, '').toLowerCase();
    const pathname = url.pathname;

    // 1. YouTube: только страницы конкретных видео, shorts или трансляций
    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
      if (hostname.includes('youtube.com')) {
        return pathname.startsWith('/watch') || pathname.startsWith('/shorts') || pathname.startsWith('/live');
      } else {
        return pathname.length > 1; // Любой путь на сокращенном домене youtu.be
      }
    }

    // 2. Reddit: только страницы постов (содержат /comments/)
    if (hostname.includes('reddit.com')) {
      return pathname.includes('/comments/');
    }

    // Сайты из BLOCKED_SITES сюда не попадают — они блокируются жёстко,
    // ещё до вызова AI-классификатора (см. handleTabCheck).
    return false;
  } catch (e) {
    return false;
  }
}

// ── Сбор данных со страницы для Reddit и любых других сайтов ───────
// Портировано 1:1 из popup.js. Выполняется в контексте страницы через
// chrome.scripting.executeScript, поэтому функция должна быть полностью
// самодостаточной (никаких ссылок на переменные из background.js).
function scrapePageData() {
  const getHeadings = () => ({
    h1: Array.from(document.querySelectorAll('h1')).map(h => h.innerText.trim()).filter(Boolean),
    h2: Array.from(document.querySelectorAll('h2')).map(h => h.innerText.trim()).filter(Boolean),
    h3: Array.from(document.querySelectorAll('h3')).map(h => h.innerText.trim()).filter(Boolean),
  });

  // Только первые 20 параграфов
  const getParagraphs = () =>
    Array.from(document.querySelectorAll('p'))
      .map(p => p.innerText.trim())
      .filter(Boolean)
      .slice(0, 20);

  // ── Reddit ──
  if (location.hostname.includes('reddit.com')) {
    try {
      let postData = null;

      if (window.__r) {
        const listing = Object.values(window.__r).find(v => v?.kind === 'Listing');
        postData = listing?.data?.children?.[0]?.data;
      }

      if (!postData) {
        const scriptEl = document.getElementById('data');
        if (scriptEl) {
          const json = JSON.parse(scriptEl.textContent.replace('window.__r = ', '').replace(/;$/, ''));
          const listing = Object.values(json).find(v => v?.kind === 'Listing');
          postData = listing?.data?.children?.[0]?.data;
        }
      }

      if (!postData) {
        const ldScripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
        for (const s of ldScripts) {
          try {
            const ld = JSON.parse(s.textContent);
            const article = Array.isArray(ld)
              ? ld.find(x => x['@type'] === 'DiscussionForumPosting')
              : (ld['@type'] === 'DiscussionForumPosting' ? ld : null);
            if (article) return {
              title: article.headline || null, description: article.articleBody || null,
              tags: null, channelName: article.author?.name || null,
              url: location.href, site: 'reddit',
              headings: getHeadings(), paragraphs: getParagraphs(),
            };
          } catch (_) {}
        }
      }

      if (postData) return {
        title: postData.title || null,
        description: postData.selftext || postData.url || null,
        tags: postData.link_flair_text || null,
        channelName: postData.author || null,
        url: location.href, site: 'reddit',
        headings: getHeadings(), paragraphs: getParagraphs(),
      };

      const postEl = document.querySelector('shreddit-post');
      return {
        title: postEl?.getAttribute('post-title') || document.title || null,
        description: document.querySelector('[slot="text-body"]')?.innerText?.slice(0, 500) || null,
        tags: postEl?.getAttribute('flair-text') || null,
        channelName: postEl?.getAttribute('author') || null,
        url: location.href, site: 'reddit',
        headings: getHeadings(), paragraphs: getParagraphs(),
      };
    } catch (e) {
      return { error: String(e), url: location.href, site: 'reddit' };
    }
  }

  // ── Universal fallback ──
  const getMeta = (...selectors) => {
    for (const sel of selectors) {
      const val = document.querySelector(sel)?.getAttribute('content');
      if (val) return val;
    }
    return null;
  };

  let jsonLd = null;
  try {
    const ld = document.querySelector('script[type="application/ld+json"]');
    if (ld) jsonLd = JSON.parse(ld.textContent);
  } catch (_) {}

  return {
    title:       getMeta('meta[property="og:title"]', 'meta[name="title"]') || document.title || null,
    description: getMeta('meta[property="og:description"]', 'meta[name="description"]') || jsonLd?.description || null,
    tags:        getMeta('meta[name="keywords"]') || null,
    channelName: getMeta('meta[name="author"]') || jsonLd?.author?.name || null,
    url:         location.href,
    headings:    getHeadings(),
    paragraphs:  getParagraphs(),   // уже срезано до 20 внутри func
  };
}

// Форматирование данных под формат Cross-Encoder'а
function buildText(page) {
  const title = page.title || "";
  const description = (page.description || "").slice(0, 300);

  // tags может быть массивом (YouTube) или строкой (Reddit flair, meta keywords)
  const tagsRaw = page.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.slice(0, 6).join(", ")
    : (tagsRaw || "");

  const headings = page.headings || {};
  const h1List = headings.h1 || [];
  const h1 = h1List[0] || "";
  const h3List = headings.h3 || [];
  const h3 = h3List.slice(0, 5).join(", ");
  const paragraphsList = page.paragraphs || [];
  const paragraphs = paragraphsList.slice(0, 3).join(" ");

  const parts = [`Title: ${title}`];
  if (description) parts.push(`Description: ${description}`);
  if (tags) parts.push(`Tags: ${tags}`);
  if (h1) parts.push(`Headings H1: ${h1}`);
  if (h3) parts.push(`Headings H3: ${h3}`);
  if (paragraphs) parts.push(`Paragraphs: ${paragraphs}`);

  return parts.join("\n");
}

// ── Основная обработка вкладок ──────────────────────────────────────
async function handleTabCheck(tabId, url) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;

  const data = await chrome.storage.local.get([
    'focusSession',
    'blockedSites',
    'blockYoutubeShortsPermanent',
    'showNotifications',
  ]);
  const focusSession = data.focusSession || { enabled: false };
  const blockedSites = Array.isArray(data.blockedSites) ? data.blockedSites : DEFAULT_BLOCKED_SITES;
  const blockShortsPermanent = !!data.blockYoutubeShortsPermanent;
  const showNotifications = data.showNotifications !== false; // по умолчанию включены

  if (!focusSession.enabled) return;

  // Проверка на истечение времени сессии
  if (focusSession.endTime && Date.now() >= focusSession.endTime) {
    await chrome.storage.local.set({
      focusSession: { focusGoal: null, endTime: null, enabled: false },
      lastSessionEndTime: Date.now(),
    });
    console.log('[Lock In Blocker] Сессия истекла, блокировка снята');
    return;
  }

  // Если этот URL на этой вкладке уже проверялся — пропускаем
  if (checkedTabs.get(tabId) === url) return;

  const hostname = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch (_) {
      return '';
    }
  })();
  const ytInfo = extractYoutubeInfo(url);

  // ── Жёсткая блокировка: BLOCKED_SITES и (опционально) YouTube Shorts ──
  // Эти проверки идут ДО AI-классификатора: цель фокус-сессии тут не
  // важна — сайт/формат блокируется целиком, пока сессия активна.
  const isHardBlockedSite = isSiteBlocked(hostname, blockedSites);
  const isHardBlockedShort = blockShortsPermanent && ytInfo.is_youtube && ytInfo.type === 'SHORTS';

  if (isHardBlockedSite || isHardBlockedShort) {
    const reason = isHardBlockedShort
      ? 'YouTube Shorts заблокированы на время фокус-сессии'
      : `Сайт "${hostname}" в списке заблокированных`;
    console.log(`[Lock In Blocker] Жёсткая блокировка: ${reason} (${url})`);
    if (showNotifications) notifyBlocked(reason);
    await redirectAway(tabId);
    return;
  }

  // Страница не попала под жёсткий блок — сбрасываем счётчик "откатов назад"
  backAttempts.delete(tabId);

  // Проверяем, нужно ли вообще классифицировать данный URL через AI
  if (!shouldCheckUrl(url)) return;

  // Если этот же tabId+url уже проходит анализ прямо сейчас — не запускаем
  // второй параллельный запуск (иначе одна и та же страница классифицируется
  // 2-3 раза подряд из-за повторных onUpdated-событий).
  if (inFlightChecks.get(tabId) === url) return;
  inFlightChecks.set(tabId, url);

  console.log(`[Lock In Blocker] Обнаружен целевой URL: ${url}. Начинаем анализ...`);

  // Задержка на рендеринг контента (особенно критично для SPA вроде YouTube/Reddit)
  await new Promise((resolve) => setTimeout(resolve, 1500));

  try {
    let pageData = null;

    // ── YouTube: используем API вместо DOM-парсинга (как в popup.js) ──
    // YouTube — SPA, и в момент проверки document.title/meta ещё могут
    // отражать предыдущую страницу или общий шаблон "YouTube", поэтому
    // DOM ненадёжен. Данные видео получаем напрямую через Data API v3.
    if (ytInfo.is_youtube && ytInfo.video_id) {
      try {
        const ytData = await fetchYoutubeData(ytInfo.video_id);
        pageData = {
          url,
          site: 'youtube',
          type: ytInfo.type,
          video_id: ytInfo.video_id,
          title: ytData.title,
          description: ytData.description,
          tags: ytData.tags,
          channelName: ytData.channelName,
          headings: {},
          paragraphs: [],
        };
      } catch (err) {
        console.warn('[Lock In Blocker] YouTube API недоступен, fallback на DOM:', err);
        // pageData останется null — упадём в общий DOM-парсер ниже
      }
    }

    // ── DOM-парсинг для Reddit и всех остальных сайтов (или fallback) ──
    if (!pageData) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: scrapePageData,
      });

      if (!results || !results[0] || !results[0].result) {
        console.warn('[Lock In Blocker] Не удалось спарсить данные со страницы.');
        return;
      }

      pageData = results[0].result;
    }

    const textPair = buildText(pageData);
    const goal = focusSession.focusGoal || "";

    const modelInstance = await getClassifier();
    if (!modelInstance) {
      console.error('[Lock In Blocker] Модель классификатора недоступна!');
      return;
    }
    const { tokenizer: tok, model: mdl } = modelInstance;

    console.log(`[Classifier] Сопоставляем цель "${goal}" с контентом страницы...`);
    console.log(`[Classifier] Текст для классификации:\n${textPair}`);

    // Токенизируем ПАРУ (goal, textPair) напрямую через токенайзер —
    // это единственный способ, которым text_pair реально доходит до модели.
    const inputs = tok(goal, {
      text_pair: textPair,
      padding: true,
      truncation: true,
    });
    const { logits } = await mdl(inputs);

    const scores = Array.from(logits.data);
    const probs = softmax(scores);

    let bestIdx = 0;
    for (let i = 1; i < probs.length; i++) {
      if (probs[i] > probs[bestIdx]) bestIdx = i;
    }

    const id2label = (mdl.config && mdl.config.id2label) || { 0: 'Denied', 1: 'Allowed' };
    const rawLabel = id2label[bestIdx] ?? id2label[String(bestIdx)] ?? String(bestIdx);
    const label = String(rawLabel).toLowerCase();
    const score = probs[bestIdx];

    // label_1 или label, содержащий "allowed", считаем пропуском
    const isAllowed = label.includes('allowed') || label === 'label_1';

    console.log(`[Classifier] Вердикт: ${rawLabel} (${(score * 100).toFixed(1)}%) -> ${isAllowed ? 'ALLOW' : 'DENY'}`);

    if (!isAllowed) {
      console.log('[Lock In Blocker] Страница не соответствует цели. Возвращаемся назад.');
      if (showNotifications) {
        notifyBlocked(`Страница не соответствует цели фокус-сессии (вердикт модели: ${rawLabel})`);
      }
      await redirectAway(tabId);
    } else {
      checkedTabs.set(tabId, url); // Запоминаем разрешенную страницу
      backAttempts.delete(tabId);
    }

  } catch (error) {
    console.error('[Lock In Blocker] Ошибка в процессе оценки контента:', error);
  } finally {
    if (inFlightChecks.get(tabId) === url) {
      inFlightChecks.delete(tabId);
    }
  }
}

// ── Мониторинг активности вкладок (включая SPA переходы) ──────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    handleTabCheck(tabId, tab.url);
  }
});

// ── Фоновая проверка таймера сессии ────────────────────────────────
chrome.alarms.create('focusSessionCheck', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'focusSessionCheck') return;
  chrome.storage.local.get('focusSession', (data) => {
    const fs = data.focusSession;
    if (fs && fs.enabled && fs.endTime && Date.now() >= fs.endTime) {
      chrome.storage.local.set({
        focusSession: { focusGoal: null, endTime: null, enabled: false },
        lastSessionEndTime: Date.now(),
      });
      console.log('[Lock In Blocker] Сессия истекла (проверка по alarm)');
    }
  });
});