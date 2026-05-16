// Abre 1 livro, espera carregar, e dumpa TUDO que pode conter texto:
// - HTML de cada iframe
// - innerText de cada iframe
// - screenshots em vários momentos
// - lista de canvas (que indicaria renderização canvas, sem texto extraível)

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SESSION_DIR = path.join(ROOT, 'session');
const COOKIES_PATH = path.join(ROOT, 'cookies.json');
const DEBUG_DIR = path.join(ROOT, 'debug');

const ASIN = process.argv[2] || 'B0752X3H64';

function normalizeCookie(c) {
  const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', httpOnly: !!c.httpOnly, secure: !!c.secure };
  if (c.expirationDate) out.expires = Math.floor(Number(c.expirationDate));
  let ss = (c.sameSite || '').toString().toLowerCase();
  if (ss === 'no_restriction' || ss === 'none' || ss === 'unspecified') ss = 'None';
  else if (ss === 'lax') ss = 'Lax';
  else if (ss === 'strict') ss = 'Strict';
  else ss = 'Lax';
  out.sameSite = ss;
  return out;
}

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  let context, browser;
  if (fs.existsSync(SESSION_DIR) && fs.readdirSync(SESSION_DIR).length > 0) {
    context = await chromium.launchPersistentContext(SESSION_DIR, {
      headless: true, viewport: { width: 1400, height: 900 }, locale: 'pt-BR'
    });
  } else {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'pt-BR' });
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8')).map(normalizeCookie);
    await context.addCookies(cookies);
  }

  const page = await context.newPage();
  console.log(`[inspect] abrindo ASIN ${ASIN}…`);
  await page.goto(`https://read.amazon.com/?asin=${ASIN}`, { waitUntil: 'domcontentloaded' });

  // dumps em 3 momentos: 3s, 8s, 15s e depois de algumas viradas
  const moments = [
    { label: 't03', wait: 3000 },
    { label: 't08', wait: 5000 },
    { label: 't15', wait: 7000 },
  ];

  for (const m of moments) {
    await page.waitForTimeout(m.wait);
    await dump(page, m.label);
  }

  // tenta clicar no centro pra dispensar overlays
  await page.click('body').catch(() => {});
  await page.waitForTimeout(1000);
  await dump(page, 'after_click');

  // vira 3 páginas
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(2500);
  }
  await dump(page, 'after_3_pages');

  console.log(`[inspect] done. Veja /home/miguel/kindle_extract/debug/`);
  await context.close();
  if (browser) await browser.close();
}

async function dump(page, label) {
  console.log(`\n=== [${label}] ===`);
  const frames = page.frames();
  console.log(`frames: ${frames.length}`);

  const summary = [];

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const url = f.url();
    let body = '';
    let bodyLen = 0;
    let bodyHtmlLen = 0;
    let canvasCount = 0;
    let textNodeSample = '';
    let interesting = {};

    try {
      const info = await f.evaluate(() => {
        const out = {
          url: location.href,
          title: document.title,
          bodyText: document.body ? document.body.innerText : '',
          bodyHtmlLen: document.body ? document.body.outerHTML.length : 0,
          canvas: document.querySelectorAll('canvas').length,
          iframes: document.querySelectorAll('iframe').length,
          selectors: {}
        };
        const trySels = [
          '#kindleReader_content', '#kindleReader_book_content', '#kindleReader',
          '.bookReaderContainer', '.textLayer',
          '[data-testid="reader-content"]',
          '#columns', '#column_0_frame', '#column_1_frame',
          'main', '#KindleReaderIFrame', '#KindleContentIFrame',
          '#KindleReader_book', '#KindleReader_setting',
          '[role="main"]', '[role="article"]',
          '[aria-label*="page"]', '[aria-label*="content"]',
          '.page', '.book-content', '.reader-content',
          '#book-content', '#book-text',
          '#region-1', '#region-2',
          '[data-region-id]',
          '.kg-full-page-img',  // pode ser imagem renderizada
          'div[dir]'  // div com texto literário tem dir
        ];
        for (const sel of trySels) {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) {
            let totalText = 0;
            for (const el of els) totalText += (el.innerText || '').length;
            out.selectors[sel] = { count: els.length, totalTextLen: totalText, firstText: els[0].innerText?.slice(0, 200) || '' };
          }
        }
        // pega divs/spans com bastante texto
        const big = [];
        for (const el of document.querySelectorAll('div, span, p, section, article')) {
          const txt = (el.innerText || '').trim();
          if (txt.length > 200 && txt.length < 3000) {
            big.push({ tag: el.tagName, cls: el.className.toString().slice(0, 60), id: el.id, len: txt.length, sample: txt.slice(0, 120) });
          }
        }
        out.bigTextEls = big.slice(0, 15);
        return out;
      });
      body = info.bodyText.slice(0, 500);
      bodyLen = info.bodyText.length;
      bodyHtmlLen = info.bodyHtmlLen;
      canvasCount = info.canvas;
      interesting = info;
    } catch (e) {
      body = `<erro: ${e.message}>`;
    }

    summary.push({ i, url, bodyLen, bodyHtmlLen, canvasCount, interesting });
    console.log(`  frame[${i}] ${url.slice(0, 80)}`);
    console.log(`    body=${bodyLen}ch html=${bodyHtmlLen}ch canvas=${canvasCount}`);
    if (interesting.iframes) console.log(`    iframes dentro: ${interesting.iframes}`);
    if (interesting.selectors && Object.keys(interesting.selectors).length > 0) {
      for (const [k, v] of Object.entries(interesting.selectors)) {
        console.log(`    ✓ ${k}: count=${v.count}, text=${v.totalTextLen}ch, "${v.firstText.replace(/\s+/g,' ').slice(0,80)}"`);
      }
    }
    if (interesting.bigTextEls?.length) {
      console.log(`    elementos com >200ch:`);
      for (const e of interesting.bigTextEls.slice(0, 5)) {
        console.log(`      <${e.tag}#${e.id} .${e.cls}> ${e.len}ch: "${e.sample.replace(/\s+/g,' ')}"`);
      }
    }

    // salva o HTML inteiro do frame se >1KB
    if (bodyHtmlLen > 1000) {
      try {
        const html = await f.evaluate(() => document.documentElement.outerHTML);
        fs.writeFileSync(path.join(DEBUG_DIR, `${label}_frame${i}.html`), html);
      } catch {}
    }
  }

  fs.writeFileSync(path.join(DEBUG_DIR, `${label}_summary.json`), JSON.stringify(summary, null, 2));
  await page.screenshot({ path: path.join(DEBUG_DIR, `${label}.png`), fullPage: false }).catch(() => {});
}

main().catch(e => { console.error(e); process.exit(1); });
