const fs = require('fs');

function extractItemId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const stack = [payload];
  const visited = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);

    const direct = current.item_id ?? current.itemId ?? current.article_id ?? current.articleId;
    if (direct !== undefined && direct !== null && String(direct).trim()) {
      return String(direct).trim();
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }
  return '';
}

function buildPublishEntryUrl(config, bookId) {
  const template =
    config.urls?.publishChapterEntryTemplate ||
    'https://fanqienovel.com/main/writer/{bookId}/publish/?enter_from=newchapter_0';
  return template.replace('{bookId}', encodeURIComponent(bookId));
}

function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function collapseBlankLines(text) {
  // Keep paragraph flow but avoid empty paragraphs between each line block.
  return normalizeNewlines(text).replace(/\n{2,}/g, '\n').trim();
}

function removeLeadingMarkdownHeadings(lines) {
  const out = [...lines];
  while (out.length > 0) {
    const line = out[0].trim();
    if (line === '') {
      out.shift();
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      out.shift();
      continue;
    }
    break;
  }
  return out;
}

function removeLeadingTitleLikeLines(lines) {
  const out = [...lines];
  while (out.length > 0) {
    const line = out[0].trim();
    if (!line) {
      out.shift();
      continue;
    }
    if (/^第[一二三四五六七八九十百千万0-9]+章[:：\s]/.test(line)) {
      out.shift();
      continue;
    }
    break;
  }
  return out;
}

function extractTitleFromFilename(filePath) {
  const base = filePath.split(/[\\/]/).pop() || '';
  const noExt = base.replace(/\.[^.]+$/, '');
  const parts = noExt.split('_').map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (/^第[一二三四五六七八九十百千万0-9]+章/.test(p)) {
      const suffix = String(parts[i + 1] || '').trim();
      if (suffix && !/^第[一二三四五六七八九十百千万0-9]+章/.test(suffix)) {
        return `${p} ${suffix}`.trim();
      }
      return p;
    }
  }
  return parts[parts.length - 1] || '';
}

function parseMarkdownExport(raw, filePath) {
  const text = normalizeNewlines(stripBom(raw));
  const lines = text.split('\n');
  let title = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const h1 = trimmed.match(/^#\s+(.+)$/);
    if (h1) {
      title = h1[1].trim();
      break;
    }
    const titleLike = trimmed.match(/^(第[一二三四五六七八九十百千万0-9]+章[：:\s].+)$/);
    if (titleLike) {
      title = titleLike[1].trim();
      break;
    }
    break;
  }

  if (!title) {
    title = extractTitleFromFilename(filePath);
  }

  let bodyLines = [...lines];
  bodyLines = removeLeadingMarkdownHeadings(bodyLines);
  bodyLines = removeLeadingTitleLikeLines(bodyLines);
  const body = bodyLines.join('\n').trim();

  return { title: title.trim(), content: body };
}

function chineseToNumber(input) {
  const s = String(input || '').trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let current = 0;
  for (const ch of s) {
    if (ch === '十') {
      current = current || 1;
      total += current * 10;
      current = 0;
      continue;
    }
    if (ch === '百') {
      current = current || 1;
      total += current * 100;
      current = 0;
      continue;
    }
    if (digits[ch] !== undefined) {
      current = digits[ch];
      continue;
    }
    return NaN;
  }
  total += current;
  return Number.isFinite(total) ? total : NaN;
}

function splitChapterHeading(fullTitle) {
  const title = String(fullTitle || '').trim();
  const m = title.match(/^第\s*([0-9一二三四五六七八九十百零〇两]+)\s*章(?:[：:_\s\-]+)?(.*)$/);
  if (!m) {
    return { number: '', pureTitle: title };
  }
  const rawNumber = m[1].trim();
  const pureTitle = (m[2] || '').trim();
  const parsed = chineseToNumber(rawNumber);
  return {
    number: Number.isFinite(parsed) && parsed > 0 ? String(parsed) : rawNumber,
    pureTitle,
  };
}

function resolveChapterInput(chapter, absPath) {
  const fallbackTitle = String(chapter.title || '').trim();
  const fallbackContent = String(chapter.content || '');
  const collapseParagraphBlankLines = chapter.collapseParagraphBlankLines !== false;
  if (!chapter.contentFile) {
    const split = splitChapterHeading(fallbackTitle);
    const content = collapseParagraphBlankLines
      ? collapseBlankLines(fallbackContent)
      : normalizeNewlines(fallbackContent).trim();
    return {
      title: split.pureTitle || fallbackTitle,
      content,
      number: String(chapter.number || split.number || '').trim(),
      rawTitle: fallbackTitle,
    };
  }
  const filePath = absPath(chapter.contentFile);
  if (!fs.existsSync(filePath)) {
    throw new Error(`chapter contentFile not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = parseMarkdownExport(raw, filePath);
  const finalTitle = fallbackTitle || parsed.title || '';
  const finalContent = fallbackContent || parsed.content || '';
  const content = collapseParagraphBlankLines
    ? collapseBlankLines(finalContent)
    : normalizeNewlines(finalContent).trim();
  const split = splitChapterHeading(finalTitle);
  return {
    title: split.pureTitle || finalTitle,
    content,
    number: String(chapter.number || split.number || '').trim(),
    rawTitle: finalTitle,
  };
}

async function fillChapterContent(page, selectors, content, clearBeforeInput, firstExistingLocator) {
  if (!content) {
    console.log('[skip] chapter content: empty');
    return false;
  }
  const hit = await firstExistingLocator(page, selectors || []);
  if (!hit) {
    console.log('[warn] chapter content: editor selector not found');
    return false;
  }

  let tagName = '';
  try {
    tagName = await hit.locator.evaluate((el) => String(el.tagName || '').toLowerCase());
  } catch {
    tagName = '';
  }

  if (tagName === 'textarea' || tagName === 'input') {
    await hit.locator.fill(content);
    console.log(`[ok] chapter content: filled via ${hit.selector}`);
    return true;
  }

  await hit.locator.click({ force: true });
  await hit.locator.evaluate((el) => {
    if (el && typeof el.focus === 'function') el.focus();
  });
  if (clearBeforeInput) {
    const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modKey}+A`);
    await page.keyboard.press('Backspace');
  }
  await page.keyboard.insertText(content);
  await page.waitForTimeout(250);
  let visibleLen = 0;
  try {
    visibleLen = await hit.locator.evaluate((el) => String(el.innerText || '').trim().length);
  } catch {
    visibleLen = 0;
  }
  console.log(
    `[ok] chapter content: inserted ${content.length} chars via ${hit.selector}, visible_len=${visibleLen}`
  );
  const minExpected = Math.max(30, Math.floor(content.length * 0.3));
  if (visibleLen >= minExpected) {
    return true;
  }

  console.log(
    `[warn] editor visible length too small (${visibleLen} < ${minExpected}), fallback to chunked typing`
  );
  await hit.locator.click({ force: true });
  await hit.locator.evaluate((el) => {
    if (el && typeof el.focus === 'function') el.focus();
  });
  if (clearBeforeInput) {
    const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modKey}+A`);
    await page.keyboard.press('Backspace');
  }

  // ProseMirror is usually more stable with chunked input than one huge insertText.
  const chunks = [];
  const chunkSize = 700;
  for (let i = 0; i < content.length; i += chunkSize) {
    chunks.push(content.slice(i, i + chunkSize));
  }
  for (const chunk of chunks) {
    await page.keyboard.insertText(chunk);
    await page.waitForTimeout(20);
  }

  await page.waitForTimeout(350);
  let fallbackLen = 0;
  try {
    fallbackLen = await hit.locator.evaluate((el) => String(el.innerText || '').trim().length);
  } catch {
    fallbackLen = 0;
  }
  console.log(`[info] chapter content fallback visible_len=${fallbackLen}`);
  return fallbackLen >= minExpected;
}

async function fillChapterTitleFallback(page, title, firstExistingLocator) {
  const fallbackSelectors = [
    "div[contenteditable='true'][data-placeholder*='标题']",
    "div[contenteditable='true'][aria-label*='标题']",
    "div[contenteditable='true']:has-text('请输入标题')",
    "div[contenteditable='plaintext-only']:has-text('请输入标题')",
  ];
  const hit = await firstExistingLocator(page, fallbackSelectors);
  if (!hit) {
    return false;
  }
  await hit.locator.click();
  const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modKey}+A`);
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(title);
  await page.waitForTimeout(150);
  let visibleLen = 0;
  try {
    visibleLen = await hit.locator.evaluate((el) => String(el.innerText || '').trim().length);
  } catch {
    visibleLen = 0;
  }
  if (visibleLen > 0) {
    console.log(`[ok] chapter title: filled via fallback ${hit.selector} visible_len=${visibleLen}`);
    return true;
  }
  console.log('[warn] chapter title fallback filled but visible length still 0');
  return false;
}

async function readResponseJsonOrText(response, truncate) {
  try {
    const json = await response.json();
    return { json, text: '' };
  } catch {
    const text = await response.text();
    return { json: null, text: truncate(text || '', 3000) };
  }
}

async function modalExists(page, hasText) {
  const locator = page.locator('.arco-modal:visible').filter({ hasText }).first();
  const count = await locator.count();
  return count > 0 ? locator : null;
}

async function clickModalButton(modal, buttonName, logLabel) {
  const btn = modal.getByRole('button', { name: buttonName }).first();
  if ((await btn.count()) <= 0) return false;
  await btn.click({ force: true });
  console.log(logLabel);
  return true;
}

async function handleKnownPublishModals(page, timeoutMs = 18000) {
  const endAt = Date.now() + timeoutMs;
  let actedAny = false;
  let idleRounds = 0;

  while (Date.now() < endAt) {
    let acted = false;

    const typoModal = await modalExists(page, '检测到你还有错别字未修改');
    if (typoModal) {
      const ok = await clickModalButton(
        typoModal,
        '提交',
        '[ok] modal handled: 错别字提示 -> 提交'
      );
      acted = acted || ok;
    }

    const riskModal = await modalExists(page, '是否进行内容风险检测');
    if (riskModal) {
      const ok = await clickModalButton(
        riskModal,
        '取消',
        '[ok] modal handled: 风险检测提示 -> 取消'
      );
      acted = acted || ok;
    }

    const aiModal = await modalExists(page, '是否使用AI');
    if (aiModal) {
      const yesRadio = aiModal.locator('label.arco-radio:has-text("是")').first();
      if ((await yesRadio.count()) > 0) {
        await yesRadio.click({ force: true });
        console.log('[ok] modal handled: 发布设置 -> 选择“是(使用AI)”');
        acted = true;
      }

      const confirmPublished = await clickModalButton(
        aiModal,
        /确认发布|确定发布/,
        '[ok] modal handled: 发布设置 -> 确认发布'
      );
      acted = acted || confirmPublished;
    }

    if (!acted) {
      const finalConfirmBtn = page
        .locator('.arco-modal:visible .arco-modal-footer button')
        .filter({ hasText: /确认发布|确定发布/ })
        .first();
      if ((await finalConfirmBtn.count()) > 0) {
        await finalConfirmBtn.click({ force: true });
        console.log('[ok] modal handled: 最终确认 -> 确认发布');
        acted = true;
      }
    }

    if (acted) {
      actedAny = true;
      idleRounds = 0;
      await page.waitForTimeout(350);
      continue;
    }

    idleRounds += 1;
    if (idleRounds >= 4) break;
    await page.waitForTimeout(400);
  }

  return actedAny;
}

async function clickPublishButtonFallback(page) {
  const candidates = [
    /下一步/,
    /发布章节/,
    /^发布$/,
    /确认发布/,
    /确定发布/,
  ];
  for (const pattern of candidates) {
    const btn = page.getByRole('button', { name: pattern }).first();
    if ((await btn.count()) <= 0) continue;
    try {
      const visible = await btn.isVisible();
      if (!visible) continue;
      await btn.click({ force: true });
      console.log(`[ok] publish button: clicked via fallback role=button name~${pattern}`);
      return true;
    } catch {
      // try next candidate
    }
  }
  return false;
}

async function clickPublishButtonWithRetry(page, clickBySelectors, selectors) {
  const maxAttempts = 8;
  for (let i = 0; i < maxAttempts; i += 1) {
    if (i === 0) {
      await page.waitForTimeout(350);
    } else {
      await page.waitForTimeout(450);
    }

    try {
      await page.waitForLoadState('networkidle', { timeout: 800 });
    } catch {
      // keep retrying on dynamic pages
    }

    const clickedBySelectors = await clickBySelectors(
      page,
      selectors || [],
      `publish button (attempt ${i + 1}/${maxAttempts})`
    );
    if (clickedBySelectors) return true;

    const clickedByFallback = await clickPublishButtonFallback(page);
    if (clickedByFallback) return true;
  }
  return false;
}

async function runPublishChapter({ page, context, config, helpers }) {
  const {
    absPath,
    ensureLoginState,
    firstExistingLocator,
    fillBySelectors,
    clickBySelectors,
    truncate,
  } = helpers;

  const chapter = config.chapter || {};
  const bookId = String(chapter.bookId || '').trim();
  if (!bookId) {
    throw new Error('config.chapter.bookId is required for publish-chapter mode');
  }

  const chapterInput = resolveChapterInput(chapter, absPath);
  const chapterTitle = chapterInput.title;
  const chapterContent = chapterInput.content;
  const chapterNumber = chapterInput.number;
  console.log(
    `[info] chapter input resolved number=${chapterNumber || 'N/A'} title_len=${chapterTitle.length} content_len=${chapterContent.length}`
  );
  if (!chapterContent) {
    throw new Error('chapter content is empty after resolving content/contentFile');
  }
  await ensureLoginState(context, page, config);

  const publishEntryUrl = buildPublishEntryUrl(config, bookId);
  const createResponsePromise = page
    .waitForResponse(
      (resp) =>
        resp.request().method() === 'POST' &&
        resp.url().includes('/api/author/article/new_article/v0/'),
      { timeout: Number(config.timeouts?.createResponseMs || 60000) }
    )
    .catch(() => null);

  await page.goto(publishEntryUrl, {
    waitUntil: 'domcontentloaded',
    timeout: Number(config.timeouts?.defaultMs || 15000),
  });
  console.log(`[info] opened publish entry: ${publishEntryUrl}`);

  let itemId = '';
  const createResp = await createResponsePromise;
  if (createResp) {
    const payload = await readResponseJsonOrText(createResp, truncate);
    if (payload.json) {
      itemId = extractItemId(payload.json);
      console.log(`[result] new_article status=${createResp.status()} item_id=${itemId || 'N/A'}`);
    } else {
      console.log(`[result] new_article status=${createResp.status()} body=${payload.text}`);
    }
  } else {
    console.log('[warn] new_article response not observed (maybe page cache or flow changed)');
  }

  try {
    await page.waitForURL(/\/publish\/\d+/, { timeout: 20000 });
  } catch {
    // keep going; some flows stay at /publish/?...
  }

  const m = page.url().match(/\/publish\/(\d+)/);
  if (m && !itemId) {
    itemId = m[1];
  }
  console.log(`[info] editor url=${page.url()} item_id=${itemId || 'N/A'}`);

  if (chapterNumber) {
    const numberFilled = await fillBySelectors(
      page,
      config.selectors?.chapterNumber || [],
      chapterNumber,
      'chapter number'
    );
    if (!numberFilled) {
      console.log(
        '[warn] chapter number: selector not found, 当前可能需要你手动填写“第几章”。'
      );
    }
  }

  const titleFilled = await fillBySelectors(
    page,
    config.selectors?.chapterTitle || [],
    chapterTitle,
    'chapter title'
  );
  if (!titleFilled && chapterTitle) {
    const fallbackFilled = await fillChapterTitleFallback(page, chapterTitle, firstExistingLocator);
    if (!fallbackFilled) {
      console.log(
        "[warn] chapter title still not filled. 请把标题输入框 selector 加到 config.local.json 的 selectors.chapterTitle。"
      );
    }
  }
  const contentFilled = await fillChapterContent(
    page,
    config.selectors?.chapterEditor || [],
    chapterContent,
    chapter.clearBeforeInput !== false,
    firstExistingLocator
  );
  if (!contentFilled) {
    console.log('[warn] chapter content may not be visible in main editor. 建议先 skip，本轮仅校准选择器。');
  }

  const publishResponsePromise = page
    .waitForResponse(
      (resp) =>
        resp.request().method() === 'POST' &&
        resp.url().includes('/api/author/publish_article/v0/'),
      { timeout: Number(config.timeouts?.createResponseMs || 60000) }
    )
    .catch(() => null);
  const chapterListResponsePromise = page
    .waitForResponse(
      (resp) =>
        resp.request().method() === 'GET' &&
        resp.url().includes('/api/author/chapter/chapter_list/v1') &&
        resp.url().includes(`book_id=${bookId}`),
      { timeout: Number(config.timeouts?.createResponseMs || 60000) }
    )
    .catch(() => null);

  const clicked = await clickPublishButtonWithRetry(
    page,
    clickBySelectors,
    config.selectors?.publishButton || []
  );
  if (!clicked) {
    throw new Error('publish button not found after retries, 请更新 selectors.publishButton 后重试');
  }
  await page.waitForTimeout(500);
  await handleKnownPublishModals(
    page,
    Number(config.timeouts?.publishDialogHandlingMs || 18000)
  );

  const publishResp = await publishResponsePromise;
  if (!publishResp) {
    console.log('[warn] publish_article response not observed');
    return;
  }

  const publishPayload = await readResponseJsonOrText(publishResp, truncate);
  if (publishPayload.json) {
    const publishedItemId = extractItemId(publishPayload.json) || itemId;
    const code = publishPayload.json?.code;
    const message = publishPayload.json?.message;
    console.log(
      `[result] publish_article status=${publishResp.status()} code=${code} message=${message || ''} item_id=${publishedItemId || 'N/A'}`
    );
    const chapterListResp = await chapterListResponsePromise;
    if (chapterListResp) {
      const chapterListPayload = await readResponseJsonOrText(chapterListResp, truncate);
      if (chapterListPayload.json) {
        const itemList = chapterListPayload.json?.data?.item_list || [];
        const matched = itemList.find(
          (x) => String(x?.item_id || x?.itemId || '') === String(publishedItemId || '')
        );
        if (matched) {
          const idx = matched.index ?? matched.chapter_number ?? matched.chapterIndex;
          const title = matched.title || matched.chapter_title || '';
          console.log(
            `[result] chapter resolved index=${idx ?? 'N/A'} title=${title || 'N/A'}`
          );
        } else {
          console.log('[warn] chapter_list received, but published item_id not found in item_list');
        }
      } else {
        console.log(`[warn] chapter_list body parse failed: ${chapterListPayload.text}`);
      }
    } else {
      console.log('[warn] chapter_list response not observed after publish');
    }
    return;
  }

  console.log(
    `[result] publish_article status=${publishResp.status()} body=${publishPayload.text}`
  );
}

module.exports = {
  runPublishChapter,
};
