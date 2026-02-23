#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const { runPublishChapter } = require('./publishChapterFlow');

const ROOT = path.resolve(__dirname, '..');
const MODE = (process.argv[2] || 'create-book').trim();
const LOCAL_CONFIG_PATH = path.join(ROOT, 'config', 'local.json');
const CONFIG_PATH = process.env.FANQIE_CONFIG
  ? path.resolve(process.env.FANQIE_CONFIG)
  : LOCAL_CONFIG_PATH;
const EXAMPLE_CONFIG_PATH = path.join(ROOT, 'config', 'example.json');

function nowStamp() {
  const d = new Date();
  return d.toISOString().replace(/[.:]/g, '-');
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(out[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig() {
  const base = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8'));
  if (!fs.existsSync(CONFIG_PATH)) {
    return base;
  }
  const local = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return deepMerge(base, local);
}

function readJsonFileSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function absPath(p) {
  if (!p) return '';
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function truncate(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...<truncated ${text.length - maxChars} chars>`;
}

function sanitizeHeaders(headers) {
  const redact = new Set([
    'cookie',
    'authorization',
    'x-secsdk-csrf-token',
    'x-ms-token',
    'x-tt-token',
    'x-tt-token-sign',
    'x-tt-passport-csrf-token',
  ]);
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    out[k] = redact.has(key) ? '__REDACTED__' : v;
  }
  return out;
}

function sanitizeUrl(rawUrl, redactSensitiveQuery) {
  if (!redactSensitiveQuery) return rawUrl;
  try {
    const u = new URL(rawUrl);
    for (const key of ['msToken', 'a_bogus', '_signature', 'X-Bogus']) {
      if (u.searchParams.has(key)) {
        u.searchParams.set(key, '__REDACTED__');
      }
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function isHttpUrl(rawUrl) {
  return /^https?:\/\//i.test(String(rawUrl || ''));
}

function shouldCaptureUrl(rawUrl, captureAll, urlIncludes) {
  if (!isHttpUrl(rawUrl)) return false;
  if (captureAll) return true;
  return (urlIncludes || []).some((part) => rawUrl.includes(part));
}

function collectBookIdsFromText(input, outSet) {
  const text = String(input || '');
  const patterns = [
    /\/main\/writer\/(\d+)(?:\/|$|\?)/g,
    /[?&]book_id=(\d+)/g,
  ];
  for (const re of patterns) {
    let m = re.exec(text);
    while (m) {
      if (m[1]) outSet.add(String(m[1]));
      m = re.exec(text);
    }
  }
}

function collectBookIdsFromPayload(payload, outSet) {
  if (!payload || typeof payload !== 'object') return;
  const stack = [payload];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === null || cur === undefined) continue;
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }
    if (typeof cur !== 'object') continue;
    for (const [k, v] of Object.entries(cur)) {
      if (typeof v === 'string' || typeof v === 'number') {
        const text = String(v);
        if (/(^|_)(book|novel)(_|)id$/i.test(String(k)) && /^\d{8,}$/.test(text)) {
          outSet.add(text);
        }
        collectBookIdsFromText(text, outSet);
      } else if (v && typeof v === 'object') {
        stack.push(v);
      }
    }
  }
}

function sortBookIdsAsc(ids) {
  return Array.from(ids || []).sort((a, b) => {
    const aa = String(a || '').trim();
    const bb = String(b || '').trim();
    if (/^\d+$/.test(aa) && /^\d+$/.test(bb)) {
      try {
        const an = BigInt(aa);
        const bn = BigInt(bb);
        if (an < bn) return -1;
        if (an > bn) return 1;
        return 0;
      } catch {
        // fall through
      }
    }
    return aa.localeCompare(bb);
  });
}

function pickLatestBookId(ids) {
  const sorted = sortBookIdsAsc(ids);
  if (!sorted.length) return '';
  return sorted[sorted.length - 1];
}

function resolvePersistConfigPath(config) {
  const fromConfig = config?.paths?.persistConfigPath;
  if (fromConfig) return absPath(fromConfig);
  return LOCAL_CONFIG_PATH;
}

function resolveBookStatePath(config) {
  return absPath(config?.paths?.bookStateFile || './state/book-ids.json');
}

function persistBookId(bookId, config, meta = {}) {
  const normalized = String(bookId || '').trim();
  if (!normalized) return { persisted: false };

  const configPath = resolvePersistConfigPath(config);
  const cfg = readJsonFileSafe(configPath, {});
  if (!cfg.chapter || typeof cfg.chapter !== 'object') {
    cfg.chapter = {};
  }
  cfg.chapter.bookId = normalized;
  writeJsonFile(configPath, cfg);

  const statePath = resolveBookStatePath(config);
  const state = readJsonFileSafe(statePath, { latestBookId: '', history: [] });
  const history = Array.isArray(state.history) ? state.history : [];
  history.push({
    bookId: normalized,
    at: new Date().toISOString(),
    mode: MODE,
    source: meta.source || 'unknown',
    title: meta.title || '',
    status: meta.status ?? null,
  });
  const trimmed = history.slice(-50);
  writeJsonFile(statePath, {
    latestBookId: normalized,
    history: trimmed,
  });

  return {
    persisted: true,
    configPath,
    statePath,
  };
}

function getRequestPageUrl(request) {
  try {
    const frame = request.frame();
    if (frame) return frame.url() || '';
  } catch {
    // Some requests (e.g. service worker) may not have a frame.
  }
  return '';
}

async function promptInput(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question}\n> `, (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

async function waitForEnter(message) {
  await promptInput(`${message}\n按回车继续`);
}

async function waitForEnterOrSkip(message) {
  const answer = await promptInput(`${message}\n回车继续，输入 skip 跳过`);
  return answer.toLowerCase() === 'skip';
}

async function waitForStopSignal(message) {
  console.log(message);
  console.log('[info] 录制中。按 Ctrl+C 停止并保存日志。');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
      resolve(reason);
    };
    const onSigInt = () => {
      console.log('\n[info] 收到 Ctrl+C，正在停止录制...');
      finish('SIGINT');
    };
    const onSigTerm = () => {
      console.log('\n[info] 收到 SIGTERM，正在停止录制...');
      finish('SIGTERM');
    };
    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);
  });
}

async function firstExistingLocator(page, selectors) {
  const frames = page.frames();
  for (const selector of selectors || []) {
    for (const frame of frames) {
      const locator = frame.locator(selector);
      let count = 0;
      try {
        count = await locator.count();
      } catch {
        count = 0;
      }
      if (count <= 0) continue;
      for (let i = 0; i < count; i += 1) {
        const candidate = locator.nth(i);
        try {
          const visible = await candidate.isVisible();
          if (!visible) continue;
          const box = await candidate.boundingBox();
          if (!box || box.width < 20 || box.height < 10) continue;
          return { selector, locator: candidate, frameUrl: frame.url() || '' };
        } catch {
          // continue searching
        }
      }
    }
  }
  return null;
}

async function waitForAnySelectorAcrossFrames(page, selectors, timeoutMs = 15000) {
  const timeoutAt = Date.now() + Math.max(1000, Number(timeoutMs || 15000));
  while (Date.now() < timeoutAt) {
    const hit = await firstExistingLocator(page, selectors);
    if (hit) return hit;
    await page.waitForTimeout(250);
  }
  return null;
}

async function fillBySelectors(page, selectors, value, label) {
  if (!value) {
    console.log(`[skip] ${label}: value empty`);
    return false;
  }
  const hit = await firstExistingLocator(page, selectors);
  if (!hit) {
    console.log(`[warn] ${label}: selector not found`);
    return false;
  }

  const expected = String(value);
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await hit.locator.click({ force: true });
    await hit.locator.fill(expected);
    await page.waitForTimeout(80);

    let actual = '';
    try {
      actual = await hit.locator.inputValue();
    } catch {
      actual = '';
    }

    if (actual === expected) {
      console.log(`[ok] ${label}: filled via ${hit.selector}${hit.frameUrl ? ` frame=${hit.frameUrl}` : ''}`);
      return true;
    }

    // Fallback for components that occasionally swallow part of the input.
    await hit.locator.fill('');
    await hit.locator.type(expected, { delay: 35 });
    await page.waitForTimeout(120);
    try {
      actual = await hit.locator.inputValue();
    } catch {
      actual = '';
    }
    if (actual === expected) {
      console.log(
        `[ok] ${label}: filled via ${hit.selector}${hit.frameUrl ? ` frame=${hit.frameUrl}` : ''} (retry ${attempt})`
      );
      return true;
    }
  }

  console.log(`[warn] ${label}: value mismatch after retries`);
  return false;
}

async function uploadFileBySelectors(page, selectors, filePath, label) {
  if (!filePath) {
    console.log(`[skip] ${label}: file path empty`);
    return false;
  }
  const abs = absPath(filePath);
  if (!fs.existsSync(abs)) {
    console.log(`[warn] ${label}: file not found -> ${abs}`);
    return false;
  }
  const hit = await firstExistingLocator(page, selectors);
  if (!hit) {
    console.log(`[warn] ${label}: file input selector not found`);
    return false;
  }
  await hit.locator.setInputFiles(abs);
  console.log(`[ok] ${label}: uploaded via ${hit.selector}${hit.frameUrl ? ` frame=${hit.frameUrl}` : ''}`);
  return true;
}

function setupNetworkCapture(context, config) {
  if (!config.capture?.enabled) {
    return { stop: async () => null, filePath: null };
  }

  const logDir = absPath(config.paths.networkLogDir || './output/network');
  ensureDir(logDir);
  const filePath = path.join(logDir, `network-${nowStamp()}.jsonl`);
  const urlIncludes = Array.isArray(config.capture.urlIncludes) ? config.capture.urlIncludes : [];
  const captureAll = !!config.capture.captureAll || urlIncludes.length === 0;
  const maxBodyChars = Number(config.capture.maxBodyChars || 8000);
  const includeResponseBody = !!config.capture.includeResponseBody;
  const redactSensitiveQuery = config.capture.redactSensitiveQuery !== false;

  const onRequest = (request) => {
    const rawUrl = request.url();
    if (!shouldCaptureUrl(rawUrl, captureAll, urlIncludes)) {
      return;
    }
    const record = {
      phase: 'request',
      at: new Date().toISOString(),
      request: {
        method: request.method(),
        url: sanitizeUrl(rawUrl, redactSensitiveQuery),
        headers: sanitizeHeaders(request.headers()),
        postData: truncate(request.postData() || '', maxBodyChars),
        resourceType: request.resourceType(),
        pageUrl: getRequestPageUrl(request),
      },
      response: null,
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  };

  const onResponse = async (response) => {
    const request = response.request();
    const rawUrl = request.url();
    if (!shouldCaptureUrl(rawUrl, captureAll, urlIncludes)) {
      return;
    }

    const record = {
      phase: 'response',
      at: new Date().toISOString(),
      request: {
        method: request.method(),
        url: sanitizeUrl(rawUrl, redactSensitiveQuery),
        headers: sanitizeHeaders(request.headers()),
        postData: truncate(request.postData() || '', maxBodyChars),
        resourceType: request.resourceType(),
        pageUrl: getRequestPageUrl(request),
      },
      response: {
        status: response.status(),
        statusText: response.statusText(),
        headers: sanitizeHeaders(response.headers()),
        body: '',
      },
    };

    if (includeResponseBody) {
      try {
        const ct = String(response.headers()['content-type'] || '').toLowerCase();
        if (ct.includes('application/json') || ct.includes('text/')) {
          record.response.body = truncate(await response.text(), maxBodyChars);
        }
      } catch (err) {
        record.response.body = `<read body failed: ${String(err)}>`;
      }
    }

    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  };

  const onRequestFailed = (request) => {
    const rawUrl = request.url();
    if (!shouldCaptureUrl(rawUrl, captureAll, urlIncludes)) {
      return;
    }
    const record = {
      phase: 'request_failed',
      at: new Date().toISOString(),
      request: {
        method: request.method(),
        url: sanitizeUrl(rawUrl, redactSensitiveQuery),
        headers: sanitizeHeaders(request.headers()),
        postData: truncate(request.postData() || '', maxBodyChars),
        resourceType: request.resourceType(),
        pageUrl: getRequestPageUrl(request),
      },
      response: {
        status: null,
        statusText: '',
        headers: {},
        body: '',
        error: request.failure()?.errorText || 'request_failed',
      },
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  };

  context.on('request', onRequest);
  context.on('response', onResponse);
  context.on('requestfailed', onRequestFailed);

  return {
    filePath,
    stop: async () => {
      context.off('request', onRequest);
      context.off('response', onResponse);
      context.off('requestfailed', onRequestFailed);
    },
  };
}

async function ensureLoginState(context, page, config) {
  const cookies = await context.cookies('https://fanqienovel.com');
  const hasSession = cookies.some(
    (c) => ['sessionid', 'sessionid_ss', 'sid_tt'].includes(c.name) && c.value
  );
  if (hasSession) {
    console.log('[ok] session cookie detected');
    return;
  }

  if (process.env.FANQIE_NON_INTERACTIVE === '1') {
    throw new Error('no session cookie found in non-interactive mode');
  }

  console.log('[warn] no session cookie found, manual login required');
  await page.goto(config.urls.writerHome, { waitUntil: 'domcontentloaded', timeout: config.timeouts.defaultMs });
  await waitForEnter('请在浏览器中完成登录');
}

async function clickBySelectors(page, selectors, label) {
  const hit = await firstExistingLocator(page, selectors);
  if (!hit) {
    console.log(`[warn] ${label}: selector not found`);
    return false;
  }
  await hit.locator.click();
  console.log(`[ok] ${label}: clicked via ${hit.selector}${hit.frameUrl ? ` frame=${hit.frameUrl}` : ''}`);
  return true;
}

function normalizeTagList(raw) {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x || '').trim()).filter(Boolean);
  }
  const text = String(raw || '').trim();
  if (!text) return [];
  return text
    .split(/[,\n，]/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function quoteForHasText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

async function clearSelectedBookTags(page, selectors) {
  const removeSelectors = [
    ...(selectors?.selectedTagRemove || []),
    '.create-category-item .item-del',
    '.create-category-item .tomato-close',
  ];
  let removed = 0;
  for (let round = 0; round < 20; round += 1) {
    const hit = await firstExistingLocator(page, removeSelectors);
    if (!hit) break;
    try {
      await hit.locator.click({ force: true });
      removed += 1;
      await page.waitForTimeout(120);
    } catch {
      break;
    }
  }
  if (removed > 0) {
    console.log(`[ok] book tags: cleared existing tags count=${removed}`);
  }
}

async function clickTagOptionByText(page, selectors, tagText) {
  const tag = String(tagText || '').trim();
  if (!tag) return false;
  const t = quoteForHasText(tag);
  const optionSelectors = [
    ...(selectors?.tagOptions || []),
    `.arco-select-option:has-text('${t}')`,
    `li[role='option']:has-text('${t}')`,
    `.arco-select-option-content:has-text('${t}')`,
    `.dropdown-menu-item:has-text('${t}')`,
    `.byte-select-option:has-text('${t}')`,
    `span.item-title:has-text('${t}')`,
    `text=${tag}`,
  ];
  const hit = await waitForAnySelectorAcrossFrames(page, optionSelectors, 3500);
  if (!hit) return false;
  try {
    await hit.locator.click({ force: true });
    return true;
  } catch {
    return false;
  }
}

async function pickTagFromModal(modalLocator, tag) {
  const safeTag = String(tag || '').trim();
  if (!safeTag) return false;

  const tryPickInCurrentPane = async () => {
    const titleNodes = modalLocator.locator('.category-choose-item-title').filter({ hasText: safeTag });
    const count = await titleNodes.count();
    if (count <= 0) return false;
    const titleNode = titleNodes.first();
    const itemNode = titleNode.locator('xpath=ancestor::div[contains(@class,"category-choose-item")]').first();
    await itemNode.click({ force: true });
    return true;
  };

  if (await tryPickInCurrentPane()) return true;

  const tabs = modalLocator.locator('.arco-tabs-header-title');
  const tabCount = await tabs.count();
  for (let i = 0; i < tabCount; i += 1) {
    await tabs.nth(i).click({ force: true });
    await modalLocator.page().waitForTimeout(180);
    if (await tryPickInCurrentPane()) return true;
  }
  return false;
}

async function pickTagFromModalByDom(page, tag) {
  const safeTag = String(tag || '').trim();
  if (!safeTag) return { ok: false, reason: 'empty_tag' };
  return page.evaluate((tagText) => {
    const dialogs = Array.from(document.querySelectorAll("div[role='dialog']"));
    const modal = dialogs.find((d) => (d.textContent || '').includes('作品标签'));
    if (!modal) return { ok: false, reason: 'modal_not_found' };

    const tabNodes = Array.from(modal.querySelectorAll('.arco-tabs-header-title'));
    const tryPickInCurrentPane = () => {
      const titles = Array.from(modal.querySelectorAll('.category-choose-item-title'));
      const hit = titles.find((n) => (n.textContent || '').trim() === tagText);
      if (!hit) return false;
      const item = hit.closest('.category-choose-item');
      if (!item) return false;
      (item).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    };

    if (tryPickInCurrentPane()) return { ok: true, mode: 'current_tab' };

    for (const tab of tabNodes) {
      tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      if (tryPickInCurrentPane()) {
        return { ok: true, mode: 'tab_scan' };
      }
    }

    const available = Array.from(modal.querySelectorAll('.category-choose-item-title'))
      .map((n) => (n.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 80);
    return { ok: false, reason: 'tag_not_found', available };
  }, safeTag);
}

async function confirmTagModalByDom(page) {
  return page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll("div[role='dialog']"));
    const modal = dialogs.find((d) => (d.textContent || '').includes('作品标签'));
    if (!modal) return { ok: false, reason: 'modal_not_found' };
    const buttons = Array.from(modal.querySelectorAll('button'));
    const confirmBtn = buttons.find((b) => (b.textContent || '').trim() === '确认');
    if (!confirmBtn) return { ok: false, reason: 'confirm_not_found' };
    confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { ok: true };
  });
}

async function fillBookTagsViaModal(page, config, tags) {
  const modalSelectors = [
    ...(config.selectors?.tagModal || []),
    "div[role='dialog'].category-modal",
    "div[role='dialog']:has-text('作品标签')",
  ];
  const modalHit = await waitForAnySelectorAcrossFrames(page, modalSelectors, 3500);
  if (!modalHit) return false;

  let allOk = true;
  for (const tag of tags) {
    let ok = await pickTagFromModal(modalHit.locator, tag);
    if (!ok) {
      const domPick = await pickTagFromModalByDom(page, tag);
      ok = !!domPick?.ok;
      if (!ok && domPick?.available?.length) {
        console.log(
          `[debug] book tags: available in modal (first ${domPick.available.length})=${JSON.stringify(domPick.available)}`
        );
      }
    }
    if (!ok) {
      allOk = false;
      console.log(`[warn] book tags: modal option not found tag=${tag}`);
      continue;
    }
    console.log(`[ok] book tags: modal selected tag=${tag}`);
    await page.waitForTimeout(140);
  }

  try {
    const domConfirm = await confirmTagModalByDom(page);
    if (domConfirm?.ok) {
      await page.waitForTimeout(220);
      console.log('[ok] book tags: modal confirmed');
      return allOk;
    }

    const confirmBtn = modalHit.locator
      .locator(
        [
          ...(config.selectors?.tagModalConfirmButton || []),
          "button.arco-btn-primary:has-text('确认')",
          "button:has-text('确认')",
        ].join(', ')
      )
      .first();
    if (await confirmBtn.count()) {
      await confirmBtn.click({ force: true });
      await page.waitForTimeout(220);
      console.log('[ok] book tags: modal confirmed');
    } else {
      allOk = false;
      console.log('[warn] book tags: modal confirm button not found');
    }
  } catch {
    allOk = false;
    console.log('[warn] book tags: modal confirm click failed');
  }

  return allOk;
}

async function fillBookTags(page, config) {
  const tags = normalizeTagList(config.book?.tags);
  if (!tags.length) {
    console.log('[skip] book tags: empty');
    return true;
  }

  if (config.book?.clearExistingTags) {
    await clearSelectedBookTags(page, config.selectors || {});
  }

  const triggerSelectors = [
    ...(config.selectors?.tagTrigger || []),
    '#selectRow_input .select-view',
    '.serial-form-item.cate-wrap .select-view',
    '.select-row .select-view',
    '.tomato-down-arrow',
  ];

  const opened = await clickBySelectors(page, triggerSelectors, 'book tags trigger');
  if (!opened) {
    console.log('[warn] book tags: trigger not found');
    return false;
  }

  await page.waitForTimeout(200);
  const viaModal = await fillBookTagsViaModal(page, config, tags);
  if (viaModal) {
    return true;
  }

  // Fallback path for dropdown-based UIs (no modal).
  let fallbackOk = true;
  for (const tag of tags) {
    const selected = await clickTagOptionByText(page, config.selectors || {}, tag);
    if (!selected) {
      fallbackOk = false;
      console.log(`[warn] book tags: dropdown option not found tag=${tag}`);
      continue;
    }
    console.log(`[ok] book tags: dropdown selected tag=${tag}`);
    await page.waitForTimeout(120);
  }

  try {
    await page.keyboard.press('Escape');
  } catch {
    // noop
  }
  return fallbackOk;
}

async function runCreateBook(page, context, config) {
  await ensureLoginState(context, page, config);

  await page.goto(config.urls.createBook, {
    waitUntil: 'domcontentloaded',
    timeout: config.timeouts.defaultMs,
  });
  await waitForAnySelectorAcrossFrames(page, config.selectors.bookTitle, Number(config.timeouts.defaultMs || 15000));
  console.log(`[info] opened ${config.urls.createBook}`);

  if (config.manual?.pauseAfterOpenCreate) {
    await waitForEnter('请确认页面已加载，并告诉我这一步你点了哪里（我们后续可固化选择器）');
  }

  await fillBySelectors(page, config.selectors.bookTitle, config.book?.title, 'book title');
  await fillBookTags(page, config);
  await fillBySelectors(page, config.selectors.protagonist1, config.book?.protagonist1, 'protagonist1');
  await fillBySelectors(page, config.selectors.protagonist2, config.book?.protagonist2, 'protagonist2');
  await fillBySelectors(page, config.selectors.bookIntro, config.book?.intro, 'book intro');
  await uploadFileBySelectors(page, config.selectors.coverFileInput, config.book?.coverPath, 'book cover');

  const detectedBookIds = new Set();
  collectBookIdsFromText(page.url(), detectedBookIds);
  const createResponsePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/author/book/create/') && resp.request().method() === 'POST',
    { timeout: config.timeouts.createResponseMs }
  );

  if (config.manual?.pauseBeforeSubmit) {
    const skip = await waitForEnterOrSkip('请人工核对表单，准备提交');
    if (skip) {
      console.log('[info] submit skipped by user');
      return;
    }
  }

  if (config.book?.autoSubmit) {
    const clicked = await clickBySelectors(page, config.selectors.submitButton, 'submit button');
    if (!clicked) {
      await waitForEnter('未找到提交按钮，请手动点击提交');
    }
  } else {
    await waitForEnter('请手动点击提交（脚本正在等待创建接口响应）');
  }

  let createResp = null;
  let createBody = '';
  let createPayload = null;
  let createOk = false;
  try {
    createResp = await createResponsePromise;
    createBody = await createResp.text();
    console.log(`[result] create response status=${createResp.status()}`);
    console.log(`[result] create response body=${truncate(createBody, 2000)}`);
    collectBookIdsFromText(createResp.url(), detectedBookIds);
    collectBookIdsFromText(createBody, detectedBookIds);
    try {
      createPayload = JSON.parse(createBody);
      collectBookIdsFromPayload(createPayload, detectedBookIds);
    } catch {
      // keep best-effort id collection from plain text/url
    }
    const code = Number(createPayload?.code);
    createOk = createResp.status() >= 200 && createResp.status() < 300 && (!Number.isFinite(code) || code === 0);
  } catch (err) {
    console.log(`[error] waiting create response failed: ${String(err)}`);
    console.log('[hint] 可能未触发 /api/author/book/create/，请检查提交按钮选择器或人工提交是否成功。');
    return;
  }

  await page.waitForTimeout(1500);
  collectBookIdsFromText(page.url(), detectedBookIds);
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href') || '')
      .filter(Boolean)
  );
  for (const href of hrefs || []) {
    collectBookIdsFromText(href, detectedBookIds);
  }
  const perfUrls = await page.evaluate(() => {
    try {
      return performance.getEntriesByType('resource').map((x) => x.name || '');
    } catch {
      return [];
    }
  });
  for (const u of perfUrls || []) {
    collectBookIdsFromText(u, detectedBookIds);
  }

  const sorted = sortBookIdsAsc(detectedBookIds);
  const latestBookId = pickLatestBookId(detectedBookIds);
  console.log(`[result] create_book_ids=${JSON.stringify({ bookIds: sorted, latestBookId })}`);
  if (!latestBookId) {
    console.log('[warn] create-book did not detect a valid bookId; please inspect network logs');
    return;
  }
  if (!createOk) {
    console.log('[warn] create response not successful, skip bookId persistence');
    return;
  }

  if (config.book?.persistBookId === false) {
    console.log(`[info] persist disabled, detected latestBookId=${latestBookId}`);
    return;
  }
  const persisted = persistBookId(latestBookId, config, {
    source: 'create-book',
    title: String(config.book?.title || '').trim(),
    status: createResp?.status?.(),
  });
  if (persisted.persisted) {
    console.log(
      `[result] persisted_book_id=${latestBookId} config=${persisted.configPath} state=${persisted.statePath}`
    );
  }
}

async function runFillCreateBookForm(page, context, config) {
  await ensureLoginState(context, page, config);
  const consoleErrors = [];
  const onConsole = (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  };
  const onPageError = (err) => {
    consoleErrors.push(String(err));
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  await page.goto(config.urls.createBook, {
    waitUntil: 'domcontentloaded',
    timeout: config.timeouts.defaultMs,
  });
  console.log(`[info] opened ${config.urls.createBook}`);
  const mounted = await waitForAnySelectorAcrossFrames(
    page,
    [
      ...(config.selectors.bookTitle || []),
      ...(config.selectors.bookIntro || []),
      ...(config.selectors.submitButton || []),
    ],
    Math.max(12000, Number(config.timeouts.defaultMs || 15000))
  );
  if (!mounted) console.log('[warn] create page hydrate timeout, continue with diagnostics');
  await page.waitForTimeout(800);

  const okTitle = await fillBySelectors(page, config.selectors.bookTitle, config.book?.title, 'book title');
  const okTags = await fillBookTags(page, config);
  const okP1 = await fillBySelectors(page, config.selectors.protagonist1, config.book?.protagonist1, 'protagonist1');
  const okP2 = config.book?.protagonist2
    ? await fillBySelectors(page, config.selectors.protagonist2, config.book?.protagonist2, 'protagonist2')
    : true;
  const okIntro = await fillBySelectors(page, config.selectors.bookIntro, config.book?.intro, 'book intro');

  const targetReader = String(config.book?.targetReader || '').trim().toLowerCase();
  if (targetReader === 'male' || targetReader === '男频') {
    await clickBySelectors(page, config.selectors.targetReaderMale, 'target reader male');
  } else if (targetReader === 'female' || targetReader === '女频') {
    await clickBySelectors(page, config.selectors.targetReaderFemale, 'target reader female');
  }

  if (!okTitle || !okTags || !okIntro || !okP1 || !okP2) {
    const diagFrames = [];
    for (const frame of page.frames()) {
      try {
        const frameDiag = await frame.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll('input, textarea')).map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: (el.getAttribute('type') || '').toLowerCase(),
            placeholder: el.getAttribute('placeholder') || '',
            className: el.getAttribute('class') || '',
            id: el.getAttribute('id') || '',
            name: el.getAttribute('name') || '',
          }));
          const buttons = Array.from(document.querySelectorAll('button')).map((el) => ({
            text: (el.textContent || '').trim(),
            className: el.getAttribute('class') || '',
            id: el.getAttribute('id') || '',
          }));
          return {
            url: location.href,
            title: document.title,
            inputCount: inputs.length,
            buttonCount: buttons.length,
            inputs: inputs.slice(0, 80),
            buttons: buttons.slice(0, 60),
          };
        });
        diagFrames.push(frameDiag);
      } catch {
        diagFrames.push({ url: frame.url() || '', error: 'frame-eval-failed' });
      }
    }
    const html = await page.content();
    const snapDir = absPath('./output/network');
    ensureDir(snapDir);
    const snapPath = path.join(snapDir, `create-form-debug-${nowStamp()}.png`);
    await page.screenshot({ path: snapPath, fullPage: true }).catch(() => {});
    const diag = {
      pageUrl: page.url(),
      htmlSize: html.length,
      htmlHead: truncate(html, 2000),
      consoleErrors: consoleErrors.slice(-20),
      screenshot: snapPath,
      frames: diagFrames,
    };
    console.log(`[debug] create_form_diag=${JSON.stringify(diag)}`);
  }

  console.log('[result] fill_create_book_form_done=true');
  if (process.env.FANQIE_NON_INTERACTIVE !== '1') {
    if (config.manual?.fillKeepOpen !== false) {
      await waitForStopSignal('已完成回填（未点击“立即创建”），浏览器保持打开，按 Ctrl+C 结束。');
    } else {
      await waitForEnter('已完成回填（未点击“立即创建”），请人工检查页面');
    }
  }
  page.off('console', onConsole);
  page.off('pageerror', onPageError);
}

async function runRecordOnly(page, context, config) {
  await ensureLoginState(context, page, config);
  const entryUrl = config.urls.recordEntry || config.urls.writerHome || config.urls.createBook;
  await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: config.timeouts.defaultMs });
  console.log(`[info] record mode started at ${entryUrl}. Do actions manually in browser.`);
  await waitForStopSignal('你可以在浏览器里完整执行章节发布流程。');
}

async function runInspect(page, context, config) {
  await ensureLoginState(context, page, config);
  await page.goto(config.urls.createBook, { waitUntil: 'domcontentloaded', timeout: config.timeouts.defaultMs });
  console.log('[info] entering Playwright inspector (page.pause)');
  console.log('[hint] 如果未弹出 Inspector，可用 PWDEBUG=1 npm run inspect');
  await page.pause();
}

async function runDetectBookId(page, context, config) {
  await ensureLoginState(context, page, config);
  const target = config.urls.writerHome || 'https://fanqienovel.com/main/writer/?enter_from=author_zone';
  const ids = new Set();
  const onResponse = async (response) => {
    try {
      const rawUrl = response.url();
      collectBookIdsFromText(rawUrl, ids);
      const ct = String(response.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json')) return;
      const text = await response.text();
      collectBookIdsFromText(text, ids);
      try {
        const payload = JSON.parse(text);
        collectBookIdsFromPayload(payload, ids);
      } catch {
        // noop
      }
    } catch {
      // noop
    }
  };
  page.on('response', onResponse);
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: config.timeouts.defaultMs });
    await page.waitForTimeout(1500);
    collectBookIdsFromText(page.url(), ids);

    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map((a) => a.getAttribute('href') || '')
        .filter(Boolean)
    );
    for (const href of hrefs || []) {
      collectBookIdsFromText(href, ids);
    }

    const perfUrls = await page.evaluate(() => {
      try {
        return performance.getEntriesByType('resource').map((x) => x.name || '');
      } catch {
        return [];
      }
    });
    for (const u of perfUrls || []) {
      collectBookIdsFromText(u, ids);
    }
  } finally {
    page.off('response', onResponse);
  }

  const sorted = sortBookIdsAsc(ids);
  const latestBookId = pickLatestBookId(ids);
  console.log(`[result] detect_book_ids=${JSON.stringify({ bookIds: sorted, latestBookId })}`);
  if (latestBookId && config.book?.persistDetectedBookId !== false) {
    const persisted = persistBookId(latestBookId, config, {
      source: 'detect-book-id',
      title: '',
      status: null,
    });
    if (persisted.persisted) {
      console.log(
        `[result] persisted_book_id=${latestBookId} config=${persisted.configPath} state=${persisted.statePath}`
      );
    }
  }
}

async function main() {
  const config = loadConfig();
  const userDataDir = absPath(config.paths.userDataDir || './state/chromium-profile');
  ensureDir(userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !!config.browser.headless,
    slowMo: Number(config.browser.slowMo || 0),
    viewport: { width: 1440, height: 900 },
  });

  const page = context.pages()[0] || (await context.newPage());
  const capture = setupNetworkCapture(context, config);

  try {
    if (MODE === 'create-book') {
      await runCreateBook(page, context, config);
    } else if (MODE === 'fill-create-book-form') {
      await runFillCreateBookForm(page, context, config);
    } else if (MODE === 'publish-chapter') {
      await runPublishChapter({
        page,
        context,
        config,
        helpers: {
          absPath,
          ensureLoginState,
          waitForEnter,
          waitForEnterOrSkip,
          firstExistingLocator,
          fillBySelectors,
          clickBySelectors,
          truncate,
        },
      });
    } else if (MODE === 'record') {
      await runRecordOnly(page, context, config);
    } else if (MODE === 'inspect') {
      await runInspect(page, context, config);
    } else if (MODE === 'detect-book-id') {
      await runDetectBookId(page, context, config);
    } else {
      throw new Error(`Unknown mode: ${MODE}`);
    }
  } finally {
    await capture.stop();
    if (capture.filePath) {
      console.log(`[info] network log saved: ${capture.filePath}`);
    }
    await context.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
