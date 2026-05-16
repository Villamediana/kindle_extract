const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const COOKIES_PATH = path.join(ROOT, 'cookies.json');
const CONFIG_PATH = path.join(ROOT, 'config.json');

function normalizeCookie(c) {
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    httpOnly: !!c.httpOnly,
    secure: !!c.secure
  };
  if (c.expirationDate) out.expires = Math.floor(Number(c.expirationDate));
  let ss = (c.sameSite || '').toString().toLowerCase();
  if (ss === 'no_restriction' || ss === 'none' || ss === 'unspecified') ss = 'None';
  else if (ss === 'lax') ss = 'Lax';
  else if (ss === 'strict') ss = 'Strict';
  else ss = 'Lax';
  out.sameSite = ss;
  return out;
}

async function harvest(page, all) {
  const items = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[id^="title-"]').forEach(el => {
      const asin = el.id.replace(/^title-/, '');
      if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return;
      const title = (el.innerText || el.textContent || '').trim();
      const authorEl = document.getElementById('author-' + asin);
      const author = authorEl ? (authorEl.innerText || '').trim() : '';
      out.push({ asin, title, author });
    });
    return out;
  });
  let added = 0;
  for (const it of items) {
    if (!all.has(it.asin) || (it.title && !all.get(it.asin).title)) {
      all.set(it.asin, it);
      added++;
    }
  }
  return added;
}

async function scrollAndCollect(page, onProgress) {
  const all = new Map();

  // Espera primeiros títulos popularem
  for (let i = 0; i < 20; i++) {
    await harvest(page, all);
    const filled = [...all.values()].filter(v => v.title).length;
    if (filled > 0) break;
    await page.waitForTimeout(750);
  }

  onProgress?.({ phase: 'scrolling', round: 0, count: all.size, delta: all.size });

  let stableRounds = 0;
  for (let round = 1; round <= 60; round++) {
    const before = all.size;

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      const containers = document.querySelectorAll('[class*="list"], [class*="grid"], [class*="library"], main, [role="main"]');
      containers.forEach(c => { c.scrollTop = c.scrollHeight; });
    });
    await page.waitForTimeout(2000);

    await harvest(page, all);
    const delta = all.size - before;

    onProgress?.({ phase: 'scrolling', round, count: all.size, delta });

    if (delta === 0) {
      stableRounds++;
      if (stableRounds >= 4) break;
    } else {
      stableRounds = 0;
    }
  }

  return [...all.values()];
}

async function scanLibrary({ headless = true, onProgress } = {}) {
  if (!fs.existsSync(COOKIES_PATH)) {
    throw new Error('cookies.json não existe');
  }
  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8')).map(normalizeCookie);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'pt-BR' });
  await context.addCookies(cookies);
  const page = await context.newPage();

  try {
    onProgress?.({ phase: 'opening' });
    await page.goto('https://read.amazon.com/kindle-library', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    if (/signin|ap\/signin/i.test(page.url())) {
      throw new Error('cookies não autenticaram (Amazon redirecionou pro login)');
    }

    onProgress?.({ phase: 'collecting' });
    const books = await scrollAndCollect(page, onProgress);
    onProgress?.({ phase: 'done', count: books.length });
    return books;
  } finally {
    try { await browser.close(); } catch {}
  }
}

function mergeIntoConfig(scanned) {
  let prev = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { prev = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
  }
  const settings = prev.settings || {
    pageDelayMs: 1500,
    screenshotEachPage: false,
    headless: true
  };

  const prevBooks = Array.isArray(prev.books) ? prev.books : [];
  const prevByAsin = new Map(prevBooks.map(b => [b.asin, b]));
  const scannedAsins = new Set(scanned.map(b => b.asin));

  const merged = scanned.map(b => {
    const existing = prevByAsin.get(b.asin) || {};
    return {
      ...existing,
      asin: b.asin,
      title: b.title || existing.title || b.asin,
      author: b.author || existing.author || undefined
    };
  });

  // preserva livros que já estavam no config mas não apareceram no scan
  const kept = prevBooks.filter(b => !scannedAsins.has(b.asin));
  const finalBooks = [...merged, ...kept];

  const newConfig = { books: finalBooks, settings };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));

  const added = merged.filter(b => !prevByAsin.has(b.asin)).length;
  return { config: newConfig, total: finalBooks.length, added, scanned: scanned.length };
}

module.exports = { scanLibrary, mergeIntoConfig, normalizeCookie };
