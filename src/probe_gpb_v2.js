// Tenta navegação realista: biblioteca → click no livro
// Capta erros 4xx/5xx + console
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const COOKIES_PATH = '/tmp/gpb_cookies.json';
const DEBUG_DIR = path.join(__dirname, '..', 'debug', 'gpb_v2');
fs.mkdirSync(DEBUG_DIR, { recursive: true });

function normalizeCookie(c) {
  const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', httpOnly: !!c.httpOnly, secure: !!c.secure };
  if (c.expirationDate) out.expires = Math.floor(Number(c.expirationDate));
  let ss = (c.sameSite || '').toString().toLowerCase();
  if (ss === 'no_restriction' || ss === 'none' || ss === 'unspecified' || ss === 'null') ss = 'None';
  else if (ss === 'lax') ss = 'Lax';
  else if (ss === 'strict') ss = 'Strict';
  else ss = 'Lax';
  out.sameSite = ss;
  return out;
}

async function main() {
  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8')).map(normalizeCookie);
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'pt-BR',
    permissions: ['clipboard-read', 'clipboard-write']
  });
  await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  await context.addCookies(cookies);

  const page = await context.newPage();

  // logs de erros e respostas suspeitas
  const badResponses = [];
  page.on('response', resp => {
    const s = resp.status();
    const u = resp.url();
    if (s >= 400 && (u.includes('books') || u.includes('reader') || u.includes('volumes'))) {
      badResponses.push({ s, u: u.slice(0, 180) });
    }
  });
  const consoleErrors = [];
  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning') {
      consoleErrors.push({ type: m.type(), text: m.text().slice(0, 200) });
    }
  });
  page.on('pageerror', e => consoleErrors.push({ type: 'pageerror', text: e.message.slice(0, 200) }));

  // 1) começa na biblioteca pra "esquentar" a sessão
  console.log('1) abrindo biblioteca...');
  await page.goto('https://play.google.com/books', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.screenshot({ path: path.join(DEBUG_DIR, '01_library.png') });
  console.log('   url:', page.url(), '— title:', await page.title());

  // 2) tenta clicar no PRIMEIRO livro (não digitar URL)
  console.log('2) procurando o primeiro card de livro pra clicar...');
  const clicked = await page.evaluate(() => {
    const sels = ['a[aria-label]', '[role="link"]', '.book-card', '[data-id]'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 50 && r.height > 50) {
          el.click();
          return { sel, text: (el.textContent||el.getAttribute('aria-label')||'').slice(0, 100) };
        }
      }
    }
    return null;
  });
  console.log('   clicked:', clicked);
  await page.waitForTimeout(4000);
  console.log('   url depois do click:', page.url());

  // se o click abriu detalhes em vez do reader, navega manualmente
  if (!page.url().includes('reader')) {
    console.log('3) click abriu detalhes; navegando manualmente pro reader...');
    await page.goto('https://play.google.com/books/reader?id=x9s2EAAAQBAJ', { waitUntil: 'domcontentloaded' });
  }

  // espera carregar
  console.log('4) aguardando conteúdo do reader carregar (até 50s)...');
  let foundAt = 0;
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => {
      let bodyLen = 0, canv = 0, blob = 0, bigImg = 0, svgT = 0;
      try {
        for (let f = 0; f < window.frames.length; f++) {
          const d = window.frames[f].document;
          bodyLen += (d.body?.innerText || '').length;
          canv += d.querySelectorAll('canvas').length;
          blob += d.querySelectorAll('img[src^="blob:"]').length;
          bigImg += [...d.querySelectorAll('img')].filter(i => i.naturalWidth > 400).length;
          svgT += d.querySelectorAll('svg text, svg tspan').length;
        }
      } catch {}
      return { bodyLen, canv, blob, bigImg, svgT };
    });
    if (i % 5 === 0) console.log(`   t${i+1}s body=${s.bodyLen} canv=${s.canv} blob=${s.blob} bigImg=${s.bigImg} svgT=${s.svgT}`);
    if (s.canv > 0 || s.blob > 0 || s.bigImg > 1 || s.svgT > 30) { foundAt = i+1; break; }
  }

  await page.screenshot({ path: path.join(DEBUG_DIR, '02_reader.png') });

  console.log('\n--- BAD RESPONSES ---');
  for (const r of badResponses.slice(0, 20)) console.log(`   ${r.s}  ${r.u}`);
  console.log('\n--- CONSOLE ERRORS / WARNINGS ---');
  for (const e of consoleErrors.slice(0, 20)) console.log(`   [${e.type}] ${e.text}`);

  if (foundAt) console.log(`\n✓ conteúdo apareceu em ${foundAt}s`);
  else console.log(`\n✗ timeout — nada apareceu em 50s`);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
