const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');
const { scanLibrary, mergeIntoConfig, normalizeCookie: libNormalizeCookie } = require('./library');
const {
  platform: hostPlatform,
  loadSetupLocal,
  saveSetupLocal,
  resolveTesseractCmd,
  probeTesseract,
  probeTesseractLangs,
  hasChromium,
  hasPlaywright,
  instructionsFor,
  ensureTessdataBest
} = require('./setup-helpers');

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
let pendingQueue = [];
let clients = new Set();
let logBuffer = [];
let runState = {
  running: false,
  startedAt: null,
  endedAt: null,
  current: null,
  recentEvents: []
};

function applyEventToRunState(evt) {
  if (evt.type === 'book_start' || evt.type === 'book_skip') {
    if (!runState.running) runState.startedAt = new Date().toISOString();
    runState.running = true;
    runState.current = {
      source: evt.source || 'kindle',
      key: evt.id || evt.asin,
      asin: evt.asin, id: evt.id,
      title: evt.title, idx: evt.idx, total: evt.total,
      page: evt.startFromPage || 0,
      totalChars: 0, rate: 0, preview: '',
      file: evt.file || null,
      startedAt: Date.now()
    };
  } else if (evt.type === 'page') {
    const k = evt.id || evt.asin;
    if (runState.current && runState.current.key === k) {
      runState.current.page = evt.page;
      runState.current.totalChars = evt.totalChars;
      runState.current.rate = evt.rate;
      runState.current.preview = evt.preview;
    }
  } else if (evt.type === 'book_end') {
    const k = evt.id || evt.asin;
    if (runState.current && runState.current.key === k) runState.current = null;
  } else if (evt.type === 'run_start') {
    if (!runState.running) runState.startedAt = new Date().toISOString();
    runState.running = true;
  } else if (evt.type === 'run_end') {
    runState.running = false;
    runState.endedAt = new Date().toISOString();
    runState.current = null;
  }
}

function broadcast(event) {
  applyEventToRunState(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
  logBuffer.push(event);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
}

function safeFileNameKindle(s) {
  return s.replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 80);
}

function loadKindleConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return null; }
}

function loadStateAt(fileBase) {
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

function kindleCookiesPresent() {
  if (!fs.existsSync(COOKIES_PATH)) return false;
  try {
    const c = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    return Array.isArray(c) && c.length > 0;
  } catch { return false; }
}

function buildBookList() {
  const out = [];
  let idx = 1;

  const k = loadKindleConfig();
  if (k && Array.isArray(k.books)) {
    for (const b of k.books) {
      const info = loadStateAt(safeFileNameKindle(b.title || b.asin));
      let status = 'pending';
      if (info.state && info.state.completed) status = 'completed';
      else if (info.state && info.state.lastPage > 0) status = 'partial';
      else if (info.hasFile) status = 'partial';
      if (runState.running && runState.current
          && runState.current.source === 'kindle'
          && runState.current.key === b.asin) status = 'extracting';
      out.push({
        idx: idx++,
        source: 'kindle',
        key: b.asin,
        asin: b.asin,
        title: b.title,
        author: b.author || '',
        ...info,
        status
      });
    }
  }

  return out;
}

// ----- API: status -----

app.get('/api/status', (req, res) => {
  const books = buildBookList();
  res.json({
    running: runState.running,
    startedAt: runState.startedAt,
    endedAt: runState.endedAt,
    current: runState.current,
    queue: pendingQueue.map(q => ({ source: q.source, count: q.keys.length })),
    cookies: { kindle: kindleCookiesPresent() },
    cookiesPresent: kindleCookiesPresent(),
    books
  });
});

// ----- API: arquivos extraídos -----

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

// ----- Orquestrador -----

function spawnKindle(asins, onDone) {
  const base = loadKindleConfig();
  if (!base) { onDone(); return; }
  const filtered = base.books.filter(b => asins.includes(b.asin));
  if (filtered.length === 0) { onDone(); return; }
  const cfg = { ...base, books: filtered };
  const tmpConfig = path.join(ROOT, '.config.run.json');
  fs.writeFileSync(tmpConfig, JSON.stringify(cfg, null, 2));

  const env = { ...process.env, JSON_EVENTS: '1', CONFIG_PATH: tmpConfig };
  broadcast({ t: Date.now(), type: 'system', source: 'kindle', msg: `▶ Iniciando Kindle (${filtered.length} livros, headless)` });
  child = spawn('node', ['src/extract.js'], { cwd: ROOT, env });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', line => {
    if (!line.trim()) return;
    let evt = null;
    try { evt = JSON.parse(line); } catch { evt = { t: Date.now(), type: 'log', msg: line }; }
    if (!evt.source) evt.source = 'kindle';
    broadcast(evt);
  });

  child.stderr.on('data', d => {
    broadcast({ t: Date.now(), type: 'stderr', source: 'kindle', msg: d.toString() });
  });

  child.on('exit', (code, signal) => {
    broadcast({ t: Date.now(), type: 'system', source: 'kindle', msg: `Kindle finalizado (code=${code}, signal=${signal || 'null'})` });
    try { if (fs.existsSync(tmpConfig)) fs.unlinkSync(tmpConfig); } catch {}
    child = null;
    onDone();
  });
}

function runNext() {
  if (pendingQueue.length === 0) {
    runState.running = false;
    runState.endedAt = new Date().toISOString();
    runState.current = null;
    broadcast({ t: Date.now(), type: 'system', msg: '✓ Fila completa' });
    return;
  }
  const item = pendingQueue.shift();
  spawnKindle(item.keys, runNext);
}

app.post('/api/start', (req, res) => {
  if (runState.running) return res.status(400).json({ error: 'já está rodando' });

  // Aceita: { keys: [{key,source}, ...] }  ou  { asins: [...] } (back-compat kindle)
  // ou nada (= todos os pendentes)
  const body = req.body || {};
  const all = buildBookList();
  let target = [];

  if (Array.isArray(body.keys) && body.keys.length > 0) {
    target = all.filter(b => body.keys.some(k => k.key === b.key));
  } else if (Array.isArray(body.asins) && body.asins.length > 0) {
    target = all.filter(b => body.asins.includes(b.asin));
  } else {
    target = all.filter(b => b.status !== 'completed');
  }

  if (target.length === 0) return res.status(400).json({ error: 'nenhum livro pendente pra extrair' });

  const kindleKeys = target.map(b => b.asin);

  pendingQueue = [];
  pendingQueue.push({ source: 'kindle', keys: kindleKeys });

  runState.running = true;
  runState.startedAt = new Date().toISOString();
  runState.endedAt = null;
  runState.current = null;
  broadcast({ t: Date.now(), type: 'system', msg: `▶ Iniciando ${kindleKeys.length} Kindle` });
  runNext();

  res.json({ ok: true, kindle: kindleKeys.length });
});

app.post('/api/stop', (req, res) => {
  if (!child && pendingQueue.length === 0) return res.status(400).json({ error: 'nada rodando' });
  pendingQueue = []; // cancela o que ainda não começou
  if (child) {
    child.kill('SIGTERM');
    setTimeout(() => { if (child) try { child.kill('SIGKILL'); } catch {} }, 3000);
  }
  res.json({ ok: true });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  res.write(`: connected\n\n`);
  for (const ev of logBuffer.slice(-100)) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ t: Date.now(), type: 'snapshot', running: runState.running, current: runState.current })}\n\n`);

  clients.add(res);
  const ka = setInterval(() => { try { res.write(`: ka\n\n`); } catch {} }, 15000);

  req.on('close', () => {
    clearInterval(ka);
    clients.delete(res);
  });
});

// ----- Cookies Kindle -----

function normalizeCookie(c) {
  return libNormalizeCookie(c);
}

app.post('/api/cookies', (req, res) => {
  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return res.status(400).json({ error: 'JSON inválido' }); }
  }
  const raw = Array.isArray(payload) ? payload : (Array.isArray(payload?.cookies) ? payload.cookies : null);
  if (!raw) return res.status(400).json({ error: 'esperado array de cookies' });
  if (raw.length === 0) return res.status(400).json({ error: 'array vazio' });

  const invalid = raw.find(c => !c.name || c.value === undefined || !c.domain);
  if (invalid) return res.status(400).json({ error: 'cookies devem ter name, value, domain' });

  const needed = ['at-main', 'sess-at-main', 'x-main', 'ubid-main', 'session-id'];
  const found = needed.filter(n => raw.some(c => c.name === n));
  if (found.length === 0) {
    return res.status(400).json({
      error: 'nenhum cookie de sessão Amazon encontrado (esperado pelo menos um de: ' + needed.join(', ') + ')'
    });
  }

  try {
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(raw, null, 2));
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

function rmIfExists(p) {
  if (!fs.existsSync(p)) return false;
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

app.post('/api/wipe', (req, res) => {
  if (runState.running) {
    return res.status(409).json({ error: 'pare a extração antes de apagar tudo' });
  }
  const wipeAll = req.body && req.body.source === 'all';
  const removed = [];
  const targets = [
    { name: 'cookies.json', path: COOKIES_PATH },
    { name: 'config.json', path: CONFIG_PATH },
    { name: '.config.run.json', path: path.join(ROOT, '.config.run.json') },
    { name: 'session/', path: SESSION_DIR }
  ];
  if (wipeAll) {
    targets.push(
      { name: 'output/', path: OUTPUT_DIR },
      { name: 'tmp_ocr/', path: path.join(ROOT, 'tmp_ocr') },
      { name: 'screenshots/', path: path.join(ROOT, 'screenshots') }
    );
  }

  for (const t of targets) {
    if (rmIfExists(t.path)) removed.push(t.name);
  }

  for (const d of [OUTPUT_DIR, path.join(ROOT, 'tmp_ocr')]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
  if (wipeAll) logBuffer = [];
  broadcast({ t: Date.now(), type: 'system', msg: `Wipe: ${removed.join(', ') || 'nada removido'}` });
  res.json({ ok: true, removed });
});

let scanRunning = false;

app.post('/api/scan-library', async (req, res) => {
  if (scanRunning) return res.status(409).json({ error: 'scan já em andamento' });
  if (!fs.existsSync(COOKIES_PATH)) {
    return res.status(400).json({ error: 'cookies.json não existe — cole os cookies primeiro' });
  }
  scanRunning = true;
  broadcast({ t: Date.now(), type: 'scan_progress', source: 'kindle', phase: 'starting', msg: 'Iniciando varredura da biblioteca' });
  try {
    const books = await scanLibrary({
      headless: true,
      onProgress: (p) => {
        broadcast({ t: Date.now(), type: 'scan_progress', source: 'kindle', ...p });
      }
    });
    if (books.length === 0) {
      broadcast({ t: Date.now(), type: 'scan_progress', source: 'kindle', phase: 'empty', msg: 'Nenhum livro encontrado' });
      return res.status(404).json({ error: 'nenhum livro encontrado na biblioteca' });
    }
    const merged = mergeIntoConfig(books);
    broadcast({
      t: Date.now(), type: 'scan_done', source: 'kindle',
      total: merged.total, added: merged.added, scanned: merged.scanned
    });
    res.json({ ok: true, ...merged });
  } catch (e) {
    broadcast({ t: Date.now(), type: 'scan_progress', source: 'kindle', phase: 'error', msg: e.message });
    res.status(500).json({ error: e.message });
  } finally {
    scanRunning = false;
  }
});

// ----- Reset de livro -----

app.post('/api/book/:key/reset', (req, res) => {
  const key = req.params.key;
  if (!/^[A-Za-z0-9_\-]{4,40}$/.test(key)) return res.status(400).json({ error: 'key inválida' });

  const all = buildBookList();
  const book = all.find(b => b.key === key);
  if (!book) return res.status(404).json({ error: 'livro não encontrado' });

  if (runState.running && runState.current && runState.current.key === key) {
    return res.status(409).json({ error: 'este livro está sendo extraído agora — pare a extração primeiro' });
  }

  const fileBase = book.fileBase;
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

function buildSetupStatus() {
  const plat = hostPlatform();
  const local = loadSetupLocal();
  const items = {};

  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  items.node = { ok: nodeMajor >= 18, version: process.version, required: '>= 18.0.0' };
  items.playwright = { ok: hasPlaywright() };
  items.chromium = { ok: hasChromium() };

  const tesseractCmd = resolveTesseractCmd();
  const tProbe = probeTesseract(tesseractCmd);
  items.tesseract = {
    ok: tProbe.ok,
    version: tProbe.version || null,
    error: tProbe.ok ? null : tProbe.error,
    cmd: tesseractCmd,
    customPath: local.tesseractPath || null
  };

  if (tProbe.ok) {
    const langs = probeTesseractLangs(tesseractCmd);
    items.tesseractPor = { ok: langs.ok && langs.langs.includes('por'), availableLangs: langs.langs };
  } else {
    items.tesseractPor = { ok: false, availableLangs: [] };
  }

  let kindleCookiesValid = false;
  if (fs.existsSync(COOKIES_PATH)) {
    try {
      const c = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
      kindleCookiesValid = Array.isArray(c) && c.length > 0 &&
        ['at-main','sess-at-main','x-main','ubid-main','session-id'].some(n => c.some(x => x.name === n));
    } catch {}
  }
  items.cookies = { ok: kindleCookiesValid };

  let kindleBooks = 0;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      kindleBooks = Array.isArray(cfg.books) ? cfg.books.length : 0;
    } catch {}
  }
  items.config = { ok: kindleBooks > 0, bookCount: kindleBooks };

  for (const key of Object.keys(items)) {
    if (!items[key].ok) {
      items[key].instructions = instructionsFor(key, plat);
    }
  }

  const allOk = Object.values(items).every(it => it.ok);
  const essentials = ['node', 'playwright', 'chromium', 'tesseract', 'tesseractPor'];
  const essentialsOk = essentials.every(k => items[k]?.ok);
  const missingCount = Object.values(items).filter(it => !it.ok).length;

  return { ok: allOk, essentialsOk, missingCount, platform: plat, items };
}

app.get('/api/setup-status', (req, res) => {
  res.json(buildSetupStatus());
});

function streamProcessAsEvents(child, channel) {
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', line => {
    if (line.trim()) {
      process.stdout.write(`[${channel}] ${line}\n`);
      broadcast({ t: Date.now(), type: channel, msg: line });
    }
  });
  // wget e apt costumam jogar progresso no stderr (linha-a-linha)
  let errBuf = '';
  child.stderr.on('data', d => {
    errBuf += d.toString();
    // quebra por linha ou por \r (carriage return — usado por progress bars)
    const parts = errBuf.split(/\r|\n/);
    errBuf = parts.pop();
    for (const p of parts) {
      const s = p.trim();
      if (!s) continue;
      process.stdout.write(`[${channel}] ${s}\n`);
      broadcast({ t: Date.now(), type: channel, msg: s, err: true });
    }
  });
  child.on('exit', () => {
    if (errBuf.trim()) {
      process.stdout.write(`[${channel}] ${errBuf.trim()}\n`);
      broadcast({ t: Date.now(), type: channel, msg: errBuf.trim(), err: true });
    }
  });
}

let installInFlight = false;
function runInstall(res, channel, cmd, args, opts = {}) {
  if (installInFlight) return res.status(409).json({ error: 'outra instalação em andamento' });
  installInFlight = true;
  broadcast({ t: Date.now(), type: channel, msg: `$ ${cmd} ${args.join(' ')}`, start: true });
  const spawnOpts = { cwd: ROOT, env: process.env, ...opts };
  if (process.platform === 'win32' && spawnOpts.shell === undefined) spawnOpts.shell = true;
  let proc;
  try { proc = spawn(cmd, args, spawnOpts); }
  catch (e) {
    installInFlight = false;
    broadcast({ t: Date.now(), type: channel, msg: `erro: ${e.message}`, err: true, end: true });
    return res.status(500).json({ ok: false, error: e.message });
  }
  streamProcessAsEvents(proc, channel);
  let responded = false;
  proc.on('exit', (code) => {
    installInFlight = false;
    broadcast({ t: Date.now(), type: channel, msg: `(exit ${code})`, end: true, code });
    if (!responded) { responded = true; res.json({ ok: code === 0, code }); }
  });
  proc.on('error', (e) => {
    installInFlight = false;
    broadcast({ t: Date.now(), type: channel, msg: `erro: ${e.message}`, err: true, end: true });
    if (!responded) { responded = true; res.status(500).json({ ok: false, error: e.message }); }
  });
}

app.post('/api/setup/install-chromium', (req, res) => {
  runInstall(res, 'install_chromium', 'npx', ['playwright', 'install', 'chromium']);
});
app.post('/api/setup/install-deps', (req, res) => {
  runInstall(res, 'install_deps', 'npm', ['install', '--no-fund', '--no-audit']);
});
app.post('/api/setup/install-tesseract', (req, res) => {
  if (process.platform !== 'linux') return res.status(400).json({ error: 'auto-install só disponível em Linux com apt-get' });
  const isRoot = process.getuid && process.getuid() === 0;
  const cmd = isRoot ? 'apt-get' : 'sudo';
  const args = isRoot
    ? ['install', '-y', 'tesseract-ocr', 'tesseract-ocr-por']
    : ['-n', 'apt-get', 'install', '-y', 'tesseract-ocr', 'tesseract-ocr-por'];
  runInstall(res, 'install_tesseract', cmd, args);
});
app.post('/api/setup/install-tesseract-por', (req, res) => {
  if (process.platform !== 'linux') return res.status(400).json({ error: 'auto-install só disponível em Linux com apt-get' });
  const isRoot = process.getuid && process.getuid() === 0;
  const cmd = isRoot ? 'apt-get' : 'sudo';
  const args = isRoot
    ? ['install', '-y', 'tesseract-ocr-por']
    : ['-n', 'apt-get', 'install', '-y', 'tesseract-ocr-por'];
  runInstall(res, 'install_tesseract_por', cmd, args);
});

app.post('/api/setup/tesseract-path', (req, res) => {
  const { path: customPath, save } = req.body || {};
  if (!customPath || typeof customPath !== 'string') return res.status(400).json({ error: 'campo "path" é obrigatório' });
  const trimmed = customPath.trim().replace(/^["']|["']$/g, '');
  if (!fs.existsSync(trimmed)) return res.status(400).json({ ok: false, error: `arquivo não encontrado: ${trimmed}` });
  const probe = probeTesseract(trimmed);
  if (!probe.ok) return res.status(400).json({ ok: false, error: `não consegui executar: ${probe.error}` });
  let langs = { ok: false, langs: [] };
  try { langs = probeTesseractLangs(trimmed); } catch {}
  if (save) saveSetupLocal({ tesseractPath: trimmed });
  res.json({ ok: true, version: probe.version, hasPor: langs.langs.includes('por'), availableLangs: langs.langs, saved: !!save });
});

app.post('/api/setup/tesseract-detect', (req, res) => {
  const candidates = [
    'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
    'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Tesseract-OCR', 'tesseract.exe'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'Tesseract-OCR', 'tesseract.exe'),
    '/usr/bin/tesseract',
    '/usr/local/bin/tesseract',
    '/opt/homebrew/bin/tesseract'
  ].filter(Boolean);

  const found = [];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const p = probeTesseract(c);
      if (p.ok) found.push({ path: c, version: p.version });
    }
  }
  res.json({ ok: found.length > 0, candidates: found });
});

// Garante tessdata_best/por.traineddata antes de aceitar requests.
// É bloqueante (curl síncrono) — primeiro startup pode demorar uns segundos pra
// baixar ~7.8 MB. Próximos startups detectam que tá presente e seguem direto.
const tessBest = ensureTessdataBest();
if (tessBest.state === 'downloaded') {
  console.log(`✓ tessdata_best baixado (${tessBest.sizeMB} MB) — OCR vai usar modelo melhor`);
} else if (tessBest.state === 'failed') {
  console.warn(`⚠ falha ao baixar tessdata_best: ${tessBest.error} — OCR vai usar tessdata do sistema`);
}

app.listen(PORT, () => {
  console.log(`Cloud Reader Extract UI rodando em http://localhost:${PORT}`);
});
