const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUTPUT_DIR = path.join(ROOT, 'output');
const SESSION_DIR = path.join(ROOT, 'session');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const COOKIES_PATH = path.join(ROOT, 'cookies.json');

const PORT = process.env.PORT || 3400;
const MAX_LOG_BUFFER = 500;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

let child = null;
let clients = new Set();
let logBuffer = [];
let runState = {
  running: false,
  startedAt: null,
  endedAt: null,
  current: null,        // { asin, title, idx, total, page, totalChars, rate, preview, file }
  recentEvents: []
};

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
  logBuffer.push(event);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
}

function safeFileName(s) {
  return s.replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 80);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch { return null; }
}

function loadStateFor(book) {
  const fileBase = safeFileName(book.title || book.asin);
  const stateFile = path.join(OUTPUT_DIR, `${fileBase}.state.json`);
  const txtFile = path.join(OUTPUT_DIR, `${fileBase}.txt`);
  let state = null;
  if (fs.existsSync(stateFile)) {
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch {}
  }
  let txtSize = 0;
  if (fs.existsSync(txtFile)) {
    try { txtSize = fs.statSync(txtFile).size; } catch {}
  }
  return {
    fileBase,
    fileName: `${fileBase}.txt`,
    hasFile: fs.existsSync(txtFile),
    txtSize,
    state
  };
}

function cookiesPresent() {
  if (!fs.existsSync(COOKIES_PATH)) return false;
  try {
    const c = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    return Array.isArray(c) && c.length > 0;
  } catch { return false; }
}

// ----- API -----

app.get('/api/status', (req, res) => {
  const config = loadConfig();
  if (!config) return res.status(400).json({ error: 'config.json não encontrado' });

  const books = config.books.map((b, i) => {
    const info = loadStateFor(b);
    let status = 'pending';
    if (info.state && info.state.completed) status = 'completed';
    else if (info.state && info.state.lastPage > 0) status = 'partial';
    else if (info.hasFile) status = 'partial';
    if (runState.running && runState.current && runState.current.asin === b.asin) status = 'extracting';
    return {
      idx: i + 1,
      asin: b.asin,
      title: b.title,
      author: b.author || '',
      ...info,
      status
    };
  });

  res.json({
    running: runState.running,
    startedAt: runState.startedAt,
    endedAt: runState.endedAt,
    current: runState.current,
    cookiesPresent: cookiesPresent(),
    settings: config.settings,
    books
  });
});

app.get('/api/file/:name', (req, res) => {
  const name = req.params.name;
  if (!/^[a-z0-9_\-]+\.txt$/i.test(name)) return res.status(400).json({ error: 'nome inválido' });
  const fp = path.join(OUTPUT_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'não encontrado' });
  const stat = fs.statSync(fp);
  const content = fs.readFileSync(fp, 'utf-8');
  res.json({ name, size: stat.size, mtime: stat.mtime, content });
});

app.get('/api/file/:name/tail', (req, res) => {
  const name = req.params.name;
  if (!/^[a-z0-9_\-]+\.txt$/i.test(name)) return res.status(400).json({ error: 'nome inválido' });
  const fp = path.join(OUTPUT_DIR, name);
  if (!fs.existsSync(fp)) return res.json({ name, size: 0, content: '' });
  const stat = fs.statSync(fp);
  const tailBytes = Math.min(stat.size, 4096);
  const fd = fs.openSync(fp, 'r');
  const buf = Buffer.alloc(tailBytes);
  fs.readSync(fd, buf, 0, tailBytes, Math.max(0, stat.size - tailBytes));
  fs.closeSync(fd);
  res.json({ name, size: stat.size, content: buf.toString('utf-8') });
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: logBuffer.slice(-200) });
});

app.post('/api/start', (req, res) => {
  if (runState.running) return res.status(400).json({ error: 'já está rodando' });
  if (!fs.existsSync(CONFIG_PATH)) return res.status(400).json({ error: 'config.json ausente' });

  const onlyAsins = Array.isArray(req.body?.asins) ? req.body.asins : null;
  let configOverride = null;
  if (onlyAsins && onlyAsins.length > 0) {
    const base = loadConfig();
    const filtered = base.books.filter(b => onlyAsins.includes(b.asin));
    if (filtered.length === 0) return res.status(400).json({ error: 'nenhum ASIN encontrado' });
    configOverride = { ...base, books: filtered };
  }

  const env = { ...process.env, JSON_EVENTS: '1' };
  let cmd = 'node';
  let args = ['src/extract.js'];

  let tmpConfig = null;
  if (configOverride) {
    tmpConfig = path.join(ROOT, '.config.run.json');
    fs.writeFileSync(tmpConfig, JSON.stringify(configOverride, null, 2));
    env.CONFIG_PATH = tmpConfig;
  }

  child = spawn(cmd, args, { cwd: ROOT, env });
  runState.running = true;
  runState.startedAt = new Date().toISOString();
  runState.endedAt = null;
  runState.current = null;
  broadcast({ t: Date.now(), type: 'system', msg: 'Extração iniciada' });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', line => {
    if (!line.trim()) return;
    let evt = null;
    try { evt = JSON.parse(line); } catch { evt = { t: Date.now(), type: 'log', msg: line }; }

    if (evt.type === 'book_start' || evt.type === 'book_skip') {
      runState.current = {
        asin: evt.asin, title: evt.title, idx: evt.idx, total: evt.total,
        page: evt.startFromPage || 0, totalChars: 0, rate: 0, preview: '',
        file: evt.file || null,
        startedAt: Date.now()
      };
    } else if (evt.type === 'page' && runState.current && runState.current.asin === evt.asin) {
      runState.current.page = evt.page;
      runState.current.totalChars = evt.totalChars;
      runState.current.rate = evt.rate;
      runState.current.preview = evt.preview;
    } else if (evt.type === 'book_end') {
      if (runState.current && runState.current.asin === evt.asin) runState.current = null;
    }

    broadcast(evt);
  });

  child.stderr.on('data', d => {
    broadcast({ t: Date.now(), type: 'stderr', msg: d.toString() });
  });

  child.on('exit', (code, signal) => {
    runState.running = false;
    runState.endedAt = new Date().toISOString();
    runState.current = null;
    broadcast({ t: Date.now(), type: 'system', msg: `Processo finalizado (code=${code}, signal=${signal || 'null'})` });
    child = null;
    if (tmpConfig && fs.existsSync(tmpConfig)) {
      try { fs.unlinkSync(tmpConfig); } catch {}
    }
  });

  res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
  if (!child) return res.status(400).json({ error: 'nada rodando' });
  child.kill('SIGTERM');
  setTimeout(() => { if (child) try { child.kill('SIGKILL'); } catch {} }, 3000);
  res.json({ ok: true });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  res.write(`: connected\n\n`);
  // Send buffered recent events
  for (const ev of logBuffer.slice(-100)) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  // Send a snapshot event
  res.write(`data: ${JSON.stringify({ t: Date.now(), type: 'snapshot', running: runState.running, current: runState.current })}\n\n`);

  clients.add(res);
  const ka = setInterval(() => { try { res.write(`: ka\n\n`); } catch {} }, 15000);

  req.on('close', () => {
    clearInterval(ka);
    clients.delete(res);
  });
});

// ----- Cookies + login check -----

function normalizeCookie(c) {
  const out = {
    name: c.name, value: c.value, domain: c.domain,
    path: c.path || '/', httpOnly: !!c.httpOnly, secure: !!c.secure
  };
  if (c.expirationDate) out.expires = Math.floor(Number(c.expirationDate));
  else if (c.expires && typeof c.expires === 'number') out.expires = Math.floor(c.expires);
  let ss = (c.sameSite || '').toString().toLowerCase();
  if (ss === 'no_restriction' || ss === 'none' || ss === 'unspecified') ss = 'None';
  else if (ss === 'lax') ss = 'Lax';
  else if (ss === 'strict') ss = 'Strict';
  else ss = 'Lax';
  out.sameSite = ss;
  return out;
}

app.post('/api/cookies', (req, res) => {
  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return res.status(400).json({ error: 'JSON inválido' }); }
  }
  // aceita tanto array direto quanto { cookies: [...] }
  const raw = Array.isArray(payload) ? payload : (Array.isArray(payload?.cookies) ? payload.cookies : null);
  if (!raw) return res.status(400).json({ error: 'esperado array de cookies' });
  if (raw.length === 0) return res.status(400).json({ error: 'array vazio' });

  // valida campos mínimos
  const invalid = raw.find(c => !c.name || c.value === undefined || !c.domain);
  if (invalid) return res.status(400).json({ error: 'cookies devem ter name, value, domain' });

  // verifica se tem ao menos um cookie de sessão Amazon
  const needed = ['at-main', 'sess-at-main', 'x-main', 'ubid-main', 'session-id'];
  const found = needed.filter(n => raw.some(c => c.name === n));
  if (found.length === 0) {
    return res.status(400).json({
      error: 'nenhum cookie de sessão Amazon encontrado (esperado pelo menos um de: ' + needed.join(', ') + ')'
    });
  }

  try {
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(raw, null, 2));
    // limpa sessão antiga para forçar uso dos cookies novos
    if (fs.existsSync(SESSION_DIR)) {
      try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
    }
    res.json({ ok: true, count: raw.length, sessionCookiesFound: found });
  } catch (e) {
    res.status(500).json({ error: 'falha ao salvar: ' + e.message });
  }
});

app.post('/api/check-login', async (req, res) => {
  if (!fs.existsSync(COOKIES_PATH)) {
    return res.status(400).json({ error: 'cookies.json não existe — cole os cookies primeiro' });
  }

  let chromium;
  try { chromium = require('playwright').chromium; }
  catch { return res.status(500).json({ error: 'playwright não instalado — rode "npm run setup"' }); }

  let browser, context;
  try {
    const raw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    const cookies = raw.map(normalizeCookie);

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'pt-BR' });
    await context.addCookies(cookies);

    const page = await context.newPage();
    await page.goto('https://read.amazon.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(4000);

    const url = page.url();
    const title = await page.title().catch(() => '');
    const isLogin = /signin|ap\/signin|login/i.test(url);

    // tenta contar livros visíveis na biblioteca
    let books = 0;
    try {
      books = await page.evaluate(() => {
        const sels = ['[data-asin]', '.book', '.kindle-library-asset', '[role="article"]'];
        for (const sel of sels) {
          const n = document.querySelectorAll(sel).length;
          if (n > 0) return n;
        }
        return 0;
      });
    } catch {}

    await browser.close();

    if (isLogin) {
      return res.json({ ok: false, url, title, error: 'cookies não autenticaram — Amazon redirecionou pro login' });
    }
    res.json({ ok: true, url, title, booksDetected: books });
  } catch (e) {
    try { if (browser) await browser.close(); } catch {}
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/book/:asin/reset', (req, res) => {
  const asin = req.params.asin;
  if (!/^[A-Z0-9]{8,12}$/i.test(asin)) return res.status(400).json({ error: 'asin inválido' });

  const config = loadConfig();
  if (!config) return res.status(400).json({ error: 'config.json não encontrado' });

  const book = config.books.find(b => b.asin === asin);
  if (!book) return res.status(404).json({ error: 'livro não está no config' });

  // não permite resetar livro que está extraindo agora
  if (runState.running && runState.current && runState.current.asin === asin) {
    return res.status(409).json({ error: 'este livro está sendo extraído agora — pare a extração primeiro' });
  }

  const fileBase = safeFileName(book.title || book.asin);
  const txtFile = path.join(OUTPUT_DIR, `${fileBase}.txt`);
  const stateFile = path.join(OUTPUT_DIR, `${fileBase}.state.json`);
  const removed = [];
  for (const f of [txtFile, stateFile]) {
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); removed.push(path.basename(f)); } catch {}
    }
  }
  res.json({ ok: true, removed });
});

// ----- Setup status (saúde do ambiente) -----

app.get('/api/setup-status', (req, res) => {
  const result = { ok: true, items: {} };

  // node
  result.items.node = { ok: true, version: process.version };

  // express + playwright instalados
  try { require.resolve('playwright'); result.items.playwright = { ok: true }; }
  catch { result.items.playwright = { ok: false }; result.ok = false; }

  // chromium baixado
  try {
    const cacheDir = path.join(process.env.HOME || '/root', '.cache', 'ms-playwright');
    const hasChromium = fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).some(d => d.startsWith('chromium'));
    result.items.chromium = { ok: hasChromium };
    if (!hasChromium) result.ok = false;
  } catch { result.items.chromium = { ok: false }; result.ok = false; }

  // tesseract
  try {
    const r = spawnSync('tesseract', ['--version'], { encoding: 'utf-8' });
    result.items.tesseract = { ok: r.status === 0, version: (r.stdout || r.stderr || '').split('\n')[0] };
    if (r.status !== 0) result.ok = false;
  } catch { result.items.tesseract = { ok: false }; result.ok = false; }

  // por language
  try {
    const r = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf-8' });
    const langs = (r.stdout + r.stderr).split('\n').map(s => s.trim());
    result.items.tesseractPor = { ok: langs.includes('por') };
    if (!langs.includes('por')) result.ok = false;
  } catch { result.items.tesseractPor = { ok: false }; result.ok = false; }

  // cookies
  result.items.cookies = { ok: fs.existsSync(COOKIES_PATH) };
  // config
  result.items.config = { ok: fs.existsSync(CONFIG_PATH) };

  res.json(result);
});

app.listen(PORT, () => {
  console.log(`Kindle Extract UI rodando em http://localhost:${PORT}`);
});
