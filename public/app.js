(() => {
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const state = {
    books: [],
    running: false,
    current: null,
    selectedKey: null,
    activeTab: 'live',
    filter: 'all',
    searchQuery: '',
    readerFontSize: 18,
    logsPaused: false,
    tailTimer: null,
    scanActive: false,
    cookies: { kindle: false }
  };

  // ---- utils ----
  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }
  function fmtNum(n) { return (n || 0).toLocaleString('pt-BR'); }
  function fmtTime(s) {
    if (s < 60) return `${Math.floor(s)}s`;
    if (s < 3600) return `${Math.floor(s/60)}m ${Math.floor(s%60)}s`;
    return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
  }
  function fmtHms(ts) {
    const d = new Date(ts);
    return d.toTimeString().slice(0, 8);
  }
  function countWords(text) {
    if (!text) return 0;
    return (text.trim().match(/\S+/g) || []).length;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function toast(msg, type='info') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (type === 'err' ? ' err' : '');
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { el.hidden = true; }, 250);
    }, 2800);
  }

  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (!r.ok) {
      let err = `${r.status}`;
      try { const j = await r.json(); err = j.error || err; } catch {}
      throw new Error(err);
    }
    return r.json();
  }

  // ---- status ----
  async function loadStatus() {
    try {
      const data = await api('/api/status');
      state.books = data.books || [];
      state.running = data.running;
      state.current = data.current;
      state.cookies = data.cookies || { kindle: !!data.cookiesPresent };
      renderTopStats(data);
      renderBookList();
      renderLive();
      $('#tabDot').className = 'tab-dot' + (state.running ? ' running' : '');
      $('#btnStart').hidden = state.running;
      $('#btnStop').hidden = !state.running;
    } catch (e) {
      toast('Erro: ' + e.message, 'err');
    }
  }

  function renderTopStats(data) {
    $('#stTotal').textContent = data.books.length;
    const done = data.books.filter(b => b.status === 'completed').length;
    const partial = data.books.filter(b => b.status === 'partial' || b.status === 'extracting').length;
    $('#stDone').textContent = done;
    $('#stPartial').textContent = partial;
    const k = !!state.cookies.kindle;
    $('#stCookiesK').textContent = k ? 'OK' : 'falta';
    $('#stCookiesK').className = 'stat-val ' + (k ? 'ok' : 'err');
    $('#btnCookies').classList.toggle('alert', !k);
  }

  function renderBookList() {
    const list = $('#bookList');
    const q = state.searchQuery.toLowerCase();
    const counts = { all: 0, completed: 0, partial: 0, pending: 0 };
    for (const b of state.books) {
      counts.all++;
      if (b.status === 'completed') counts.completed++;
      else if (b.status === 'partial' || b.status === 'extracting') counts.partial++;
      else counts.pending++;
    }
    $('#cntAll').textContent = counts.all;
    $('#cntCompleted').textContent = counts.completed;
    $('#cntPartial').textContent = counts.partial;
    $('#cntPending').textContent = counts.pending;

    const filtered = state.books.filter(b => {
      if (state.filter === 'completed' && b.status !== 'completed') return false;
      if (state.filter === 'partial' && b.status !== 'partial' && b.status !== 'extracting') return false;
      if (state.filter === 'pending' && b.status !== 'pending') return false;
      if (q && !(b.title.toLowerCase().includes(q) || (b.author||'').toLowerCase().includes(q))) return false;
      return true;
    });

    list.innerHTML = '';
    for (const b of filtered) {
      const li = document.createElement('li');
      li.className = 'book'
        + (state.selectedKey === b.key ? ' selected' : '')
        + (b.excluded ? ' excluded' : '');
      li.dataset.key = b.key;
      const sizeStr = b.txtSize ? fmtBytes(b.txtSize) : '';
      const canReset = b.hasFile || (b.state && b.state.lastPage > 0);
      const exTitle = b.excluded
        ? 'Incluir de novo na extração em massa'
        : 'Pular este livro na extração em massa';
      // Eye icon for "incluído" (visível), eye-off for "excluído".
      const exIcon = b.excluded
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l18 18"/><path d="M10.6 6.1A9 9 0 0 1 12 6c5.4 0 9 6 9 6a14 14 0 0 1-2.7 3.5"/><path d="M6.7 7.4A14 14 0 0 0 3 12s3.6 6 9 6a9 9 0 0 0 3.5-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>'
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
      li.innerHTML = `
        <span class="book-status-dot ${b.status}"></span>
        <div class="book-info">
          <div class="book-title">${escapeHtml(b.title)}</div>
          <div class="book-author">${escapeHtml(b.author || '—')}</div>
        </div>
        <div class="book-actions">
          <button class="book-action-btn" data-action="toggle-excluded" title="${exTitle}">${exIcon}</button>
          ${canReset ? `<button class="book-action-btn" data-action="reset" title="Apagar progresso">⟳</button>` : ''}
        </div>
        <div class="book-size">${sizeStr}</div>
      `;
      li.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="reset"]')) {
          e.stopPropagation();
          confirmReset(b);
        } else if (e.target.closest('[data-action="toggle-excluded"]')) {
          e.stopPropagation();
          toggleExcluded(b);
        } else {
          selectBook(b.key);
        }
      });
      list.appendChild(li);
    }
    if (!filtered.length) {
      const msg = state.books.length === 0
        ? 'cole os cookies do Kindle ou envie um PDF pra começar'
        : 'nenhum livro nesse filtro';
      list.innerHTML = `<li style="padding:20px;text-align:center;color:var(--text-3);font-size:12px">${escapeHtml(msg)}</li>`;
    }
  }

  function renderLive() {
    const live = state.current;
    if (!live) {
      $('#liveEmpty').hidden = false;
      $('#liveBody').hidden = true;
      return;
    }
    $('#liveEmpty').hidden = true;
    $('#liveBody').hidden = false;

    $('#nowCounter').textContent = live.idx && live.total ? `${live.idx}/${live.total}` : '';
    $('#nowTitle').textContent = live.title || live.key;
    const book = state.books.find(b => b.key === live.key);
    $('#nowAuthor').textContent = book?.author || '';

    $('#mPage').textContent = fmtNum(live.page || 0);
    $('#mChars').textContent = fmtNum(live.totalChars || 0);
    $('#mRate').textContent = (live.rate || 0).toFixed(2);
    const elapsedS = live.startedAt ? (Date.now() - live.startedAt) / 1000 : 0;
    $('#mElapsed').textContent = fmtTime(elapsedS);

    const pct = Math.min(100, (live.page || 0) / 800 * 100);
    $('#progBar').style.width = pct + '%';

    $('#previewText').textContent = live.preview || 'aguardando primeira página…';
    $('#previewDot').className = 'preview-dot' + (state.running ? ' active' : '');

    if (live.file) {
      $('#tailFileName').textContent = live.file;
      $('#btnOpenInReader').hidden = false;
      $('#btnOpenInReader').onclick = () => {
        state.selectedKey = live.key;
        switchTab('reader');
        renderBookList();
        loadReader(live.key);
      };
      scheduleTail(live.file);
    }
  }

  function scheduleTail(file) {
    if (state.tailTimer) clearInterval(state.tailTimer);
    const fetchTail = async () => {
      try {
        const r = await api(`/api/file/${encodeURIComponent(file)}/tail`);
        $('#tailText').textContent = r.content || '—';
        $('#tailText').scrollTop = $('#tailText').scrollHeight;
      } catch {}
    };
    fetchTail();
    state.tailTimer = setInterval(fetchTail, 2500);
  }

  function selectBook(key) {
    state.selectedKey = key;
    renderBookList();
    switchTab('reader');
    loadReader(key);
    closeSidebar();
  }

  function openSidebar() {
    $('.sidebar').classList.add('open');
    const bd = $('#sidebarBackdrop');
    bd.hidden = false;
    bd.classList.add('open');
  }
  function closeSidebar() {
    $('.sidebar').classList.remove('open');
    const bd = $('#sidebarBackdrop');
    bd.classList.remove('open');
    bd.hidden = true;
  }

  function statPill(label, val, mono = false) {
    return `<div class="stat-pill">
      <div class="stat-pill-val${mono ? ' mono' : ''}">${escapeHtml(val)}</div>
      <div class="stat-pill-label">${escapeHtml(label)}</div>
    </div>`;
  }

  function renderReaderHead(b, extra = {}) {
    const isCompleted = b.status === 'completed';
    const isPartial = b.status === 'partial' || b.status === 'extracting';
    const isExtracting = b.status === 'extracting';
    const badgeClass = isCompleted ? 'badge ok' : isPartial ? 'badge warn' : 'badge';
    const badgeLabel = isExtracting ? 'Extraindo agora' :
                       isCompleted ? 'Completo' :
                       isPartial ? 'Parcial' : 'Não extraído';
    $('#rBadge').className = badgeClass;
    $('#rBadge').textContent = badgeLabel;
    $('#rTitle').textContent = b.title;
    const isPdf = b.source === 'pdf';
    $('#rAuthor').textContent = (!isPdf && b.author) ? `por ${b.author}` : '';
    $('#rAuthor').hidden = isPdf || !b.author;
    $('#rAsin').textContent = isPdf ? `PDF · ${b.key}` : `ASIN ${b.key}`;

    const pages = b.state?.lastPage || 0;
    const totalChars = b.state?.totalChars || extra.size || 0;
    const words = extra.words;

    const pills = [];
    if (pages > 0) pills.push(statPill('páginas', fmtNum(pages)));
    if (words != null) pills.push(statPill('palavras', fmtNum(words)));
    if (totalChars > 0) pills.push(statPill('tamanho', fmtBytes(totalChars)));
    if (b.state?.abortReason && !isCompleted) {
      pills.push(statPill('última parada', b.state.abortReason));
    }
    $('#rStats').innerHTML = pills.join('');
    $('#rStats').hidden = pills.length === 0;
  }

  async function loadReader(key) {
    const b = state.books.find(x => x.key === key);
    if (!b) return;

    $('#readerEmpty').hidden = true;
    $('#readerBody').hidden = false;

    if (!b.hasFile) {
      renderReaderHead(b);
      $('#rNotExtracted').hidden = false;
      $('#rContent').innerHTML = '';
      $('#rContent').hidden = true;
      $('#btnDownload').disabled = true;
      $('#btnExtractThis').onclick = async () => {
        try {
          await api('/api/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: [{ key: b.key }] })
          });
          toast(`Extraindo "${b.title}"…`);
          switchTab('live');
        } catch (e) { toast('Erro: ' + e.message, 'err'); }
      };
      return;
    }

    $('#rNotExtracted').hidden = true;
    $('#rContent').hidden = false;
    $('#btnDownload').disabled = false;

    try {
      const data = await api(`/api/file/${encodeURIComponent(b.fileName)}`);
      const words = countWords(data.content);
      renderReaderHead(b, { size: data.size, words });
      const html = data.content
        .split(/\n\n+/)
        .filter(p => p.trim())
        .map(p => `<p>${escapeHtml(p.trim())}</p>`)
        .join('');
      $('#rContent').innerHTML = html;
      $('#rContent').style.fontSize = state.readerFontSize + 'px';
      $('#btnDownload').onclick = () => {
        const blob = new Blob([data.content], { type: 'text/plain; charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = b.fileName;
        a.click();
      };
    } catch (e) {
      toast('Erro ao ler arquivo: ' + e.message, 'err');
    }
  }

  function switchTab(name) {
    state.activeTab = name;
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.panel').forEach(p => p.hidden = p.dataset.panel !== name);
    if (name === 'reader' && state.selectedKey) loadReader(state.selectedKey);
  }

  function appendLog(ev) {
    const logs = $('#logs');
    const line = document.createElement('div');
    line.className = 'log-line';
    const ident = ev.title || ev.id || ev.asin || '';
    const msg = ev.msg || (ev.type === 'page' ? `pág ${ev.page} · ${fmtBytes(ev.totalChars)} · ${(ev.rate||0).toFixed(2)} pg/s` : ev.type === 'book_start' ? `★ ${ident}` : ev.type === 'book_end' ? (ev.completed ? `✓ ${fmtNum(ev.lastPage)} págs · ${fmtBytes(ev.totalChars)}` : `⚠ ${ev.abortReason || 'parado'}`) : JSON.stringify(ev));
    line.innerHTML = `
      <span class="log-time">${fmtHms(ev.t)}</span>
      <span class="log-type ${ev.type}">${ev.type}</span>
      <span class="log-msg">${escapeHtml(msg)}</span>
    `;
    logs.appendChild(line);
    while (logs.children.length > 500) logs.removeChild(logs.firstChild);
    if (!state.logsPaused) logs.scrollTop = logs.scrollHeight;
  }

  function eventKey(ev) { return ev.id || ev.asin || ''; }

  function handleEvent(ev) {
    appendLog(ev);
    const evKey = eventKey(ev);
    if (ev.type === 'book_start' || ev.type === 'book_skip') {
      state.current = {
        key: evKey, asin: ev.asin, id: ev.id, title: ev.title, idx: ev.idx, total: ev.total,
        page: ev.startFromPage || 0, totalChars: 0, rate: 0, preview: '',
        file: ev.file || null,
        startedAt: Date.now()
      };
      state.running = true;
      loadStatus();
    } else if (ev.type === 'page') {
      if (!state.current || state.current.key !== evKey) return;
      state.current.page = ev.page;
      state.current.totalChars = ev.totalChars;
      state.current.rate = ev.rate;
      state.current.preview = ev.preview;
      renderLive();
    } else if (ev.type === 'book_end') {
      setTimeout(loadStatus, 400);
    } else if (ev.type === 'system') {
      if (ev.msg && (ev.msg.includes('Fila completa') || ev.msg.startsWith('Processo finalizado'))) {
        state.running = false;
        state.current = null;
        loadStatus();
      }
    } else if (ev.type === 'snapshot') {
      state.running = ev.running;
      if (ev.current) state.current = ev.current;
    } else if (ev.type === 'scan_progress') {
      if (state.scanActive) {
        let msg;
        if (ev.phase === 'starting') msg = 'iniciando…';
        else if (ev.phase === 'opening') msg = 'abrindo biblioteca…';
        else if (ev.phase === 'collecting') msg = 'coletando títulos…';
        else if (ev.phase === 'scrolling') msg = `rolando — ${ev.count || 0} livros encontrados`;
        else if (ev.phase === 'done') msg = `varredura completa: ${ev.count} livros`;
        else if (ev.phase === 'empty') msg = 'nenhum livro encontrado';
        else if (ev.phase === 'error') msg = `erro: ${ev.msg}`;
        else msg = ev.phase;
        setCookieStatus(`<span class="loader"></span> ${escapeHtml(msg)}`, 'info');
      }
    } else if (ev.type === 'scan_done') {
      if (state.scanActive) {
        setCookieStatus(`✓ ${ev.total} livros importados (${ev.added} novos).`, 'ok');
      }
    } else if (ev.type && ev.type.startsWith('install_')) {
      appendSetupConsole(ev.msg || '');
    }
  }

  function connectSSE() {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      try { handleEvent(JSON.parse(e.data)); } catch {}
    };
    es.onerror = () => {};
  }

  // ---- setup modal ----
  const ITEM_LABELS = {
    node: 'Node.js',
    playwright: 'Dependências npm',
    chromium: 'Chromium (Playwright)',
    tesseract: 'Tesseract OCR',
    tesseractPor: 'Idioma português (Tesseract)',
    cookies: 'Cookies do Kindle',
    config: 'Lista de livros Kindle'
  };
  const ITEM_ORDER = ['node', 'playwright', 'chromium', 'tesseract', 'tesseractPor', 'cookies', 'config'];

  let setupAutoOpened = false;
  let setupStatusCache = null;

  function appendSetupConsole(line) {
    const c = $('#setupConsole');
    const log = $('#setupConsoleLog');
    c.hidden = false;
    c.open = true;
    log.textContent += line + '\n';
    log.scrollTop = log.scrollHeight;
  }

  function setupPlatformChip(plat) {
    const el = $('#setupPlatform');
    const map = { linux: 'Linux', mac: 'macOS', windows: 'Windows' };
    el.textContent = map[plat] || plat;
    el.dataset.plat = plat;
  }

  function renderSetupItem(key, item) {
    const label = ITEM_LABELS[key] || key;
    const li = document.createElement('li');
    li.className = 'setup-item ' + (item.ok ? 'ok' : 'missing');
    li.dataset.key = key;

    const status = item.ok ? '✓' : '✗';
    let detailLine = '';
    if (key === 'node') detailLine = `${item.version} (precisa ${item.required})`;
    else if (key === 'tesseract' && item.ok) detailLine = item.version || '';
    else if (key === 'tesseract' && !item.ok) detailLine = item.error ? `erro: ${item.error}` : 'não encontrado';
    else if (key === 'tesseractPor' && item.availableLangs?.length) detailLine = `idiomas: ${item.availableLangs.join(', ')}`;
    else if (key === 'config' && item.bookCount) detailLine = `${item.bookCount} livros`;
    else if (item.ok) detailLine = 'tudo certo';
    else detailLine = 'não configurado';

    li.innerHTML = `
      <div class="setup-item-head">
        <span class="setup-status ${item.ok ? 'ok' : 'missing'}">${status}</span>
        <div class="setup-item-text">
          <div class="setup-item-title">${escapeHtml(label)}</div>
          <div class="setup-item-detail">${escapeHtml(detailLine)}</div>
        </div>
      </div>
      <div class="setup-item-body"></div>
    `;

    const body = li.querySelector('.setup-item-body');
    if (!item.ok && item.instructions) {
      body.appendChild(renderInstructions(key, item));
    }
    return li;
  }

  function renderInstructions(key, item) {
    const ins = item.instructions;
    const wrap = document.createElement('div');
    wrap.className = 'instructions';

    if (ins.title) {
      const h = document.createElement('div');
      h.className = 'instructions-title';
      h.textContent = ins.title;
      wrap.appendChild(h);
    }

    if (ins.steps && ins.steps.length) {
      const ol = document.createElement('ol');
      ol.className = 'instructions-steps';
      for (const s of ins.steps) {
        const li = document.createElement('li');
        li.textContent = s;
        ol.appendChild(li);
      }
      wrap.appendChild(ol);
    }

    if (ins.download) {
      const a = document.createElement('a');
      a.href = ins.download;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'btn-link instructions-download';
      a.textContent = `Abrir página de download →`;
      wrap.appendChild(a);
    }

    if (ins.commands && ins.commands.length) {
      const block = document.createElement('div');
      block.className = 'instructions-commands';
      for (const c of ins.commands) {
        const row = document.createElement('div');
        row.className = 'cmd-row';
        row.innerHTML = `<code>${escapeHtml(c)}</code><button class="cmd-copy" data-cmd="${escapeHtml(c)}">copiar</button>`;
        block.appendChild(row);
      }
      wrap.appendChild(block);
    }

    if (ins.showPathInput) {
      const input = document.createElement('div');
      input.className = 'tesseract-path-block';
      const local = setupStatusCache?.items?.tesseract?.customPath || '';
      input.innerHTML = `
        <div class="path-row">
          <input type="text" id="tessPathInput" placeholder="C:\\Program Files\\Tesseract-OCR\\tesseract.exe"
                 value="${escapeHtml(local)}" autocomplete="off">
          <button id="tessDetect" class="btn">Detectar</button>
          <button id="tessValidate" class="btn btn-primary">Validar &amp; salvar</button>
        </div>
        <div id="tessPathStatus" class="modal-status"></div>
      `;
      wrap.appendChild(input);
    }

    if (ins.autoInstall) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary install-now';
      btn.dataset.endpoint = ins.autoInstall.endpoint;
      btn.textContent = ins.autoInstall.label || 'Instalar agora';
      wrap.appendChild(btn);
    }

    if (ins.openCookiesModal) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = 'Abrir importação de cookies';
      btn.onclick = () => {
        closeModal('setupModal');
        $('#cookiesStatus').className = 'modal-status';
        $('#cookiesStatus').textContent = '';
        openModal('cookiesModal');
      };
      wrap.appendChild(btn);
    }

    if (ins.note) {
      const n = document.createElement('div');
      n.className = 'instructions-note';
      n.textContent = ins.note;
      wrap.appendChild(n);
    }

    return wrap;
  }

  async function loadSetupStatus(autoOpenIfBroken = false) {
    try {
      const data = await api('/api/setup-status');
      setupStatusCache = data;
      setupPlatformChip(data.platform);

      const ul = $('#setupChecklist');
      ul.innerHTML = '';
      for (const key of ITEM_ORDER) {
        if (!data.items[key]) continue;
        ul.appendChild(renderSetupItem(key, data.items[key]));
      }

      const summary = $('#setupSummary');
      if (data.ok) {
        summary.className = 'setup-summary ok';
        summary.innerHTML = '✓ Tudo pronto. Você pode iniciar a extração.';
      } else if (data.essentialsOk) {
        summary.className = 'setup-summary warn';
        summary.innerHTML = `⚠ ${data.missingCount} item(ns) opcionais faltando — você pode usar o sistema, mas configure cookies/biblioteca pra rodar.`;
      } else {
        summary.className = 'setup-summary err';
        summary.innerHTML = `✗ ${data.missingCount} item(ns) precisam ser resolvidos antes de extrair.`;
      }

      $('#setupBadge').hidden = data.ok;

      if (autoOpenIfBroken && !data.essentialsOk && !setupAutoOpened) {
        setupAutoOpened = true;
        openModal('setupModal');
      }
      return data;
    } catch (e) {
      toast('Falha ao checar setup: ' + e.message, 'err');
    }
  }

  $('#setupModal').addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('.cmd-copy');
    if (copyBtn) {
      const cmd = copyBtn.dataset.cmd;
      try {
        await navigator.clipboard.writeText(cmd);
        copyBtn.textContent = 'copiado ✓';
        setTimeout(() => { copyBtn.textContent = 'copiar'; }, 1500);
      } catch { toast('falha ao copiar', 'err'); }
      return;
    }

    const installBtn = e.target.closest('.install-now');
    if (installBtn) {
      const endpoint = installBtn.dataset.endpoint;
      installBtn.disabled = true;
      installBtn.textContent = 'instalando…';
      $('#setupConsole').hidden = false;
      $('#setupConsole').open = true;
      $('#setupConsoleLog').textContent = '';
      try {
        const r = await api(endpoint, { method: 'POST' });
        if (r.ok) toast('Instalado com sucesso');
        else toast(`Instalação retornou código ${r.code}`, 'err');
      } catch (err) {
        toast('Erro: ' + err.message, 'err');
      } finally {
        installBtn.disabled = false;
        loadSetupStatus(false);
      }
      return;
    }

    if (e.target.id === 'tessDetect') {
      e.target.disabled = true;
      try {
        const r = await api('/api/setup/tesseract-detect', { method: 'POST' });
        if (r.candidates && r.candidates.length) {
          const inp = $('#tessPathInput');
          inp.value = r.candidates[0].path;
          $('#tessPathStatus').className = 'modal-status show info';
          $('#tessPathStatus').textContent = `Detectado: ${r.candidates[0].version}`;
        } else {
          $('#tessPathStatus').className = 'modal-status show err';
          $('#tessPathStatus').textContent = 'Nenhum tesseract encontrado nos caminhos padrão.';
        }
      } catch (err) {
        $('#tessPathStatus').className = 'modal-status show err';
        $('#tessPathStatus').textContent = 'Erro: ' + err.message;
      } finally {
        e.target.disabled = false;
      }
      return;
    }

    if (e.target.id === 'tessValidate') {
      const p = $('#tessPathInput').value.trim();
      if (!p) {
        $('#tessPathStatus').className = 'modal-status show err';
        $('#tessPathStatus').textContent = 'Cole o caminho antes';
        return;
      }
      e.target.disabled = true;
      $('#tessPathStatus').className = 'modal-status show info';
      $('#tessPathStatus').innerHTML = '<span class="loader"></span> validando…';
      try {
        const r = await api('/api/setup/tesseract-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p, save: true })
        });
        const porMsg = r.hasPor ? 'idioma "por" OK' : '⚠ idioma "por" não encontrado — reinstale o Tesseract incluindo o pacote português';
        $('#tessPathStatus').className = 'modal-status show ' + (r.hasPor ? 'ok' : 'warn');
        $('#tessPathStatus').textContent = `✓ Salvo: ${r.version}. ${porMsg}`;
        toast('Caminho do tesseract salvo');
        setTimeout(() => loadSetupStatus(false), 500);
      } catch (err) {
        $('#tessPathStatus').className = 'modal-status show err';
        $('#tessPathStatus').textContent = '✗ ' + err.message;
      } finally {
        e.target.disabled = false;
      }
    }
  });

  $('#btnSetup').addEventListener('click', () => {
    openModal('setupModal');
    loadSetupStatus(false);
  });
  $('#setupClose').addEventListener('click', () => closeModal('setupModal'));
  $('#setupDone').addEventListener('click', () => closeModal('setupModal'));
  $('#setupRecheck').addEventListener('click', () => loadSetupStatus(false));

  // ---- modais ----
  function openModal(id) {
    $('#' + id).hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeModal(id) {
    $('#' + id).hidden = true;
    document.body.style.overflow = '';
  }

  function confirmDialog(title, msg, onOk) {
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').textContent = msg;
    openModal('confirmModal');
    const ok = $('#confirmOk');
    const cancel = $('#confirmCancel');
    const close = $('#confirmClose');
    const cleanup = () => {
      ok.onclick = null; cancel.onclick = null; close.onclick = null;
      closeModal('confirmModal');
    };
    ok.onclick = () => { cleanup(); onOk(); };
    cancel.onclick = cleanup;
    close.onclick = cleanup;
  }

  async function toggleExcluded(book) {
    const next = !book.excluded;
    try {
      await api(`/api/book/${encodeURIComponent(book.key)}/excluded`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ excluded: next })
      });
      toast(next ? `"${book.title}" pulado na extração em massa` : `"${book.title}" voltou pra fila`);
      await loadStatus();
    } catch (e) {
      toast('Erro: ' + e.message, 'err');
    }
  }

  async function confirmReset(book) {
    confirmDialog(
      'Apagar conteúdo extraído?',
      `Remove o .txt e o estado salvo de "${book.title}". Nada começa automaticamente.`,
      async () => {
        try {
          const r = await api(`/api/book/${encodeURIComponent(book.key)}/reset`, { method: 'POST' });
          toast(`Removido: ${r.removed.join(', ') || '(nada)'}`);
          await loadStatus();
          if (state.selectedKey === book.key) loadReader(book.key);
        } catch (e) { toast('Erro: ' + e.message, 'err'); }
      }
    );
  }

  // ---- cookies modal (só Kindle) ----
  $('#btnCookies').addEventListener('click', () => {
    $('#cookiesStatus').className = 'modal-status';
    $('#cookiesStatus').textContent = '';
    openModal('cookiesModal');
  });
  $('#cookiesClose').addEventListener('click', () => closeModal('cookiesModal'));

  function setCookieStatus(msg, kind = 'info') {
    const el = $('#cookiesStatus');
    el.className = 'modal-status show ' + kind;
    el.innerHTML = msg;
  }

  function parseCookiesInput() {
    const raw = $('#cookiesInput').value.trim();
    if (!raw) throw new Error('cole o JSON dos cookies antes');
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new Error('JSON inválido: ' + e.message); }
    if (!Array.isArray(parsed)) {
      if (Array.isArray(parsed.cookies)) parsed = parsed.cookies;
      else throw new Error('formato inesperado — esperado array');
    }
    return parsed;
  }

  $('#cookiesValidate').addEventListener('click', async () => {
    const btn = $('#cookiesValidate');
    btn.disabled = true;
    try {
      const cookies = parseCookiesInput();
      setCookieStatus('<span class="loader"></span> Salvando cookies…', 'info');
      await api('/api/cookies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cookies)
      });
      setCookieStatus('<span class="loader"></span> Testando login…', 'info');
      const r = await api('/api/check-login', { method: 'POST' });
      if (!r.ok) {
        setCookieStatus(`✗ ${r.error || 'falhou'}. URL final: <code>${escapeHtml(r.url || '')}</code>`, 'err');
        loadStatus();
        return;
      }
      state.scanActive = true;
      setCookieStatus('<span class="loader"></span> Login OK — listando biblioteca (pode levar até 1 min)…', 'info');
      try {
        const scan = await api('/api/scan-library', { method: 'POST' });
        setCookieStatus(`✓ Pronto! ${scan.total} livros importados (${scan.added} novos).`, 'ok');
        toast(`${scan.total} livros importados`);
        setTimeout(() => closeModal('cookiesModal'), 1500);
      } catch (e) {
        setCookieStatus(`✗ Login OK mas falhou ao listar livros: ${e.message}`, 'err');
      } finally {
        state.scanActive = false;
      }
      loadStatus();
    } catch (e) {
      state.scanActive = false;
      setCookieStatus('✗ ' + e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('#btnWipeAll').addEventListener('click', () => {
    confirmDialog(
      'Apagar tudo?',
      'Remove cookies, lista de livros e textos extraídos. Não dá pra desfazer.',
      async () => {
        try {
          const r = await api('/api/wipe', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'all' })
          });
          toast(`Apagado: ${r.removed.length ? r.removed.length + ' item(ns)' : 'nada'}`);
          $('#cookiesInput').value = '';
          state.selectedKey = null;
          $('#readerEmpty').hidden = false;
          $('#readerBody').hidden = true;
          await loadStatus();
        } catch (e) { toast('Erro: ' + e.message, 'err'); }
      }
    );
  });

  $('#btnReset').addEventListener('click', () => {
    if (!state.selectedKey) return;
    const b = state.books.find(x => x.key === state.selectedKey);
    if (b) confirmReset(b);
  });

  // ---- start/stop ----
  $('#btnStart').addEventListener('click', async () => {
    try {
      const r = await api('/api/start', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
      const parts = [];
      if (r.kindle) parts.push(`${r.kindle} Kindle`);
      if (r.pdf)    parts.push(`${r.pdf} PDF${r.pdf > 1 ? 's' : ''}`);
      toast(parts.length ? `Fila: ${parts.join(' + ')}` : 'Extração iniciada');
    } catch (e) { toast('Erro: ' + e.message, 'err'); }
  });

  // ---- sync (Kindle library scan) ----
  // Re-uses /api/scan-library — the same endpoint the cookies modal hits
  // after a successful login. Here it's exposed as a standalone button so
  // the user can pull new books without going through the modal flow.
  // Requires cookies already configured; falls through to a toast hint if
  // not.
  $('#btnSync').addEventListener('click', async () => {
    if (!state.cookies.kindle) {
      toast('configure os cookies do Kindle primeiro', 'err');
      return;
    }
    const btn = $('#btnSync');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="loader"></span> sincronizando…';
    try {
      const r = await api('/api/scan-library', { method: 'POST' });
      const added = r.added || 0;
      const total = r.total || 0;
      if (added > 0) toast(`✓ ${added} novo${added > 1 ? 's' : ''} de ${total}`);
      else           toast(`Biblioteca em dia — ${total} livro${total === 1 ? '' : 's'}`);
      await loadStatus();
    } catch (e) {
      toast('Erro: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  });

  // ---- PDF upload ----
  // The button is just a proxy that opens the (hidden) file input. The
  // input's change handler does the actual upload + queues extraction on
  // the server side; we just need to refresh status afterwards so the new
  // PDF shows up in the sidebar with the right status.
  $('#btnUploadPdf').addEventListener('click', () => {
    $('#pdfFileInput').click();
  });
  $('#pdfFileInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';   // reset so picking the same file twice re-fires
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) {
      toast('só arquivos .pdf', 'err');
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    const btn = $('#btnUploadPdf');
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span class="loader"></span> enviando…';
    try {
      const r = await fetch('/api/upload-pdf', { method: 'POST', body: fd });
      if (!r.ok) {
        let err = `HTTP ${r.status}`;
        try { const j = await r.json(); err = j.error || err; } catch {}
        throw new Error(err);
      }
      const data = await r.json();
      toast(`PDF enviado: ${data.originalName || data.file}`);
      // The server auto-queues the upload; switch to live so the user
      // sees the extraction kicking off, and refresh the sidebar.
      switchTab('live');
      await loadStatus();
    } catch (err) {
      toast('Erro: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  });

  $('#btnStop').addEventListener('click', async () => {
    if (!confirm('Parar a extração?')) return;
    try {
      await api('/api/stop', { method: 'POST' });
      toast('Parando…');
    } catch (e) { toast('Erro: ' + e.message, 'err'); }
  });

  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $$('.filter').forEach(f => f.addEventListener('click', () => {
    $$('.filter').forEach(x => x.classList.remove('active'));
    f.classList.add('active');
    state.filter = f.dataset.filter;
    renderBookList();
  }));

  $('#search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderBookList();
  });

  $('#btnFontMinus').addEventListener('click', () => {
    state.readerFontSize = Math.max(14, state.readerFontSize - 1);
    $('#rContent').style.fontSize = state.readerFontSize + 'px';
  });
  $('#btnFontPlus').addEventListener('click', () => {
    state.readerFontSize = Math.min(28, state.readerFontSize + 1);
    $('#rContent').style.fontSize = state.readerFontSize + 'px';
  });

  $('#btnClearLogs').addEventListener('click', () => { $('#logs').innerHTML = ''; });

  // sidebar drawer (mobile)
  $('#btnMenu').addEventListener('click', () => {
    if ($('.sidebar').classList.contains('open')) closeSidebar();
    else openSidebar();
  });
  $('#sidebarBackdrop').addEventListener('click', closeSidebar);

  // ---- init ----
  loadStatus();
  connectSSE();
  loadSetupStatus(true);
  setInterval(loadStatus, 6000);
})();
