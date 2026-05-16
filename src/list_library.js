const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const COOKIES_PATH = path.join(ROOT, 'cookies.json');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SHOTS_DIR = path.join(ROOT, 'screenshots');

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

async function scrollAndCollect(page) {
  // O conteúdo é carregado em lotes conforme rola. A gente coleta a cada round,
  // armazena num set, rola pro fim, espera, e repete até parar de crescer.
  const all = new Map();

  async function harvest() {
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
    return { roundCount: items.length, totalUnique: all.size, added };
  }

  // Espera o primeiro título popular (pode levar alguns segundos)
  for (let i = 0; i < 20; i++) {
    const { totalUnique } = await harvest();
    if (totalUnique > 0) {
      const filled = [...all.values()].filter(v => v.title).length;
      if (filled > 0) break;
    }
    await page.waitForTimeout(750);
  }

  // Agora rola pra carregar mais
  let stableRounds = 0;
  for (let round = 0; round < 60; round++) {
    await harvest();
    const before = all.size;

    // Tenta rolar a janela e o container principal
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      const containers = document.querySelectorAll('[class*="list"], [class*="grid"], [class*="library"], main, [role="main"]');
      containers.forEach(c => { c.scrollTop = c.scrollHeight; });
    });
    await page.waitForTimeout(2000);

    await harvest();
    const after = all.size;
    console.log(`  rodada ${round + 1}: ${after} livros (delta ${after - before})`);

    if (after === before) {
      stableRounds++;
      if (stableRounds >= 4) break;
    } else {
      stableRounds = 0;
    }
  }

  return [...all.values()];
}

async function main() {
  if (!fs.existsSync(COOKIES_PATH)) {
    console.error('Falta cookies.json');
    process.exit(1);
  }
  if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8')).map(normalizeCookie);
  console.log(`Carregando ${cookies.length} cookies...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'pt-BR' });
  await context.addCookies(cookies);

  const page = await context.newPage();
  console.log('Abrindo biblioteca...');
  await page.goto('https://read.amazon.com/kindle-library', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const url = page.url();
  if (/signin|ap\/signin/i.test(url)) {
    console.error('Redirecionado pro login. Cookies não autenticaram.');
    await browser.close();
    process.exit(2);
  }

  console.log('Coletando livros (com scroll incremental)...');
  const books = await scrollAndCollect(page);

  const shot = path.join(SHOTS_DIR, 'library_final.png');
  await page.screenshot({ path: shot, fullPage: true });

  await browser.close();

  if (books.length === 0) {
    console.error('Nenhum livro encontrado.');
    process.exit(3);
  }

  // Mescla com config.json existente (preserva settings)
  let prev = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { prev = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
  }
  const settings = prev.settings || {
    pageDelayMs: 1500,
    screenshotEachPage: false,
    headless: true
  };

  const newConfig = {
    books: books.map(b => ({
      asin: b.asin,
      title: b.title || b.asin,
      author: b.author || undefined
    })),
    settings
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
  console.log(`\nGravado ${books.length} livros em ${CONFIG_PATH}`);
  console.log('\nPrimeiros 10:');
  books.slice(0, 10).forEach((b, i) =>
    console.log(`  ${i + 1}. [${b.asin}] ${b.title}${b.author ? ' — ' + b.author : ''}`)
  );
  console.log(`\nScreenshot: ${shot}`);
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
