#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const { runPublishChapter } = require('./publishChapterFlow');

const ROOT = path.resolve(__dirname, '..');
const MODE = (process.argv[2] || 'create-book').trim();
const CONFIG_PATH = process.env.FANQIE_CONFIG
  ? path.resolve(process.env.FANQIE_CONFIG)
  : path.join(ROOT, 'config', 'local.json');
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
  for (const selector of selectors || []) {
    const locator = page.locator(selector);
    const count = await locator.count();
    if (count <= 0) continue;
    for (let i = 0; i < count; i += 1) {
      const candidate = locator.nth(i);
      try {
        const visible = await candidate.isVisible();
        if (!visible) continue;
        const box = await candidate.boundingBox();
        if (!box || box.width < 20 || box.height < 10) continue;
        return { selector, locator: candidate };
      } catch {
        // continue searching
      }
    }
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
  await hit.locator.fill('');
  await hit.locator.type(value, { delay: 20 });
  console.log(`[ok] ${label}: filled via ${hit.selector}`);
  return true;
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
  console.log(`[ok] ${label}: uploaded via ${hit.selector}`);
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
  console.log(`[ok] ${label}: clicked via ${hit.selector}`);
  return true;
}

async function runCreateBook(page, context, config) {
  await ensureLoginState(context, page, config);

  await page.goto(config.urls.createBook, {
    waitUntil: 'domcontentloaded',
    timeout: config.timeouts.defaultMs,
  });
  console.log(`[info] opened ${config.urls.createBook}`);

  if (config.manual?.pauseAfterOpenCreate) {
    await waitForEnter('请确认页面已加载，并告诉我这一步你点了哪里（我们后续可固化选择器）');
  }

  await fillBySelectors(page, config.selectors.bookTitle, config.book?.title, 'book title');
  await fillBySelectors(page, config.selectors.bookIntro, config.book?.intro, 'book intro');
  await uploadFileBySelectors(page, config.selectors.coverFileInput, config.book?.coverPath, 'book cover');

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

  try {
    const resp = await createResponsePromise;
    const body = await resp.text();
    console.log(`[result] create response status=${resp.status()}`);
    console.log(`[result] create response body=${truncate(body, 2000)}`);
  } catch (err) {
    console.log(`[error] waiting create response failed: ${String(err)}`);
    console.log('[hint] 可能未触发 /api/author/book/create/，请检查提交按钮选择器或人工提交是否成功。');
  }
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
