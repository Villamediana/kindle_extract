(() => {
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const state = {
    books: [],
    running: false,
    current: null,
    selectedAsin: null,
    activeTab: 'live',
    filter: 'all',
    searchQuery: '',
    readerFontSize: 18,
    logsPaused: false,
    tailTimer: null
  };

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

  async function loadStatus() {
    try {
      const data = await api('/api/status');
      state.books = data.books;
      state.running = data.running;
      state.current = data.current;
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
    $('#stCookies').textContent = data.cookiesPresent ? 'OK' : 'falta';
    $('#stCookies').className = 'stat-val ' + (data.cookiesPresent ? 'ok' : 'err');
    $('#btnCookies').classList.toggle('alert', !data.cookiesPresent);
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
      li.className = 'book' + (state.selectedAsin === b.asin ? ' selected' : '');
      li.dataset.asin = b.asin;
      const sizeStr = b.txtSize ? fmtBytes(b.txtSize) : '';
      const canReset = b.hasFile || (b.state && b.state.lastPage > 0);
      li.innerHTML = `
        <span class="book-status-dot ${b.status}"></span>
        <div class="book-info">
          <div class="book-title">${escapeHtml(b.title)}</div>
          <div class="book-author">${escapeHtml(b.author || '—')}</div>
        </div>
        <div class="book-actions">
          ${canReset ? `<button class="book-action-btn" data-action="reset" title="Apagar progresso">⟳</button>` : ''}
        </div>
        <div class="book-size">${sizeStr}</div>
      `;
      li.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="reset"]')) {
          e.stopPropagation();
          confirmReset(b);
        } else {
          selectBook(b.asin);
        }
      });
      list.appendChild(li);
    }
    if (!filtered.length) {
      list.innerHTML = '<li style="padding:20px;text-align:center;color:var(--text-3);font-size:12px">nenhum livro nesse filtro</li>';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
    $('#nowTitle').textContent = live.title || live.asin;
    const book = state.books.find(b => b.asin === live.asin);
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
        state.selectedAsin = live.asin;
        switchTab('reader');
        renderBookList();
        loadReader(live.asin);
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

  function selectBook(asin) {
    state.selectedAsin = asin;
    renderBookList();
    if (state.activeTab === 'reader') loadReader(asin);
    else {
      // hint: switch to reader if has file
      const b = state.books.find(x => x.asin === asin);
      if (b && b.hasFile) {
        switchTab('reader');
        loadReader(asin);
      }
    }
  }

  async function loadReader(asin) {
    const b = state.books.find(x => x.asin === asin);
    if (!b) return;
    if (!b.hasFile) {
      $('#readerEmpty').hidden = false;
      $('#readerBody').hidden = true;
      $('#readerEmpty').querySelector('.empty-title').textContent = 'Este livro ainda não foi extraído';
      $('#readerEmpty').querySelector('.empty-sub').textContent = 'Inicie a extração para gerar o texto.';
      return;
    }
    try {
      const data = await api(`/api/file/${encodeURIComponent(b.fileName)}`);
      $('#readerEmpty').hidden = true;
      $('#readerBody').hidden = false;
      $('#rEyebrow').textContent = b.status === 'completed' ? 'Livro completo' : 'Extração parcial';
      $('#rTitle').textContent = b.title;
      $('#rMeta').textContent = `${b.author || '—'} · ${fmtBytes(data.size)} · ${fmtNum((data.content.match(/\s+/g)||[]).length)} palavras`;
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
    if (name === 'reader' && state.selectedAsin) loadReader(state.selectedAsin);
  }

  function appendLog(ev) {
    const logs = $('#logs');
    const line = document.createElement('div');
    line.className = 'log-line';
    const msg = ev.msg || (ev.type === 'page' ? `pág ${ev.page} · ${fmtBytes(ev.totalChars)} · ${(ev.rate||0).toFixed(2)} pg/s` : ev.type === 'book_start' ? `★ ${ev.title || ev.asin}` : ev.type === 'book_end' ? (ev.completed ? `✓ ${fmtNum(ev.lastPage)} págs · ${fmtBytes(ev.totalChars)}` : `⚠ ${ev.abortReason || 'parado'}`) : JSON.stringify(ev));
    line.innerHTML = `
      <span class="log-time">${fmtHms(ev.t)}</span>
      <span class="log-type ${ev.type}">${ev.type}</span>
      <span class="log-msg">${escapeHtml(msg)}</span>
    `;
    logs.appendChild(line);
    while (logs.children.length > 500) logs.removeChild(logs.firstChild);
    if (!state.logsPaused) logs.scrollTop = logs.scrollHeight;
  }

  function handleEvent(ev) {
    appendLog(ev);
    if (ev.type === 'book_start' || ev.type === 'book_skip') {
      state.current = {
        asin: ev.asin, title: ev.title, idx: ev.idx, total: ev.total,
        page: ev.startFromPage || 0, totalChars: 0, rate: 0, preview: '',
        file: ev.file || null,
        startedAt: Date.now()
      };
      state.running = true;
      loadStatus();
    } else if (ev.type === 'page') {
      if (!state.current || state.current.asin !== ev.asin) return;
      state.current.page = ev.page;
      state.current.totalChars = ev.totalChars;
      state.current.rate = ev.rate;
      state.current.preview = ev.preview;
      renderLive();
    } else if (ev.type === 'book_end') {
      // pause briefly then refresh
      setTimeout(loadStatus, 400);
    } else if (ev.type === 'system') {
      if (ev.msg && ev.msg.startsWith('Processo finalizado')) {
        state.running = false;
        state.current = null;
        loadStatus();
      }
    } else if (ev.type === 'snapshot') {
      state.running = ev.running;
      if (ev.current) state.current = ev.current;
    }
  }

  function connectSSE() {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      try { handleEvent(JSON.parse(e.data)); } catch {}
    };
    es.onerror = () => {
      // reconexão automática do EventSource
    };
  }

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

  async function confirmReset(book) {
    confirmDialog(
      'Apagar progresso?',
      `Apagar a extração de "${book.title}"? Isso remove o .txt e o estado salvo. A próxima extração começa do zero.`,
      async () => {
        try {
          const r = await api(`/api/book/${book.asin}/reset`, { method: 'POST' });
          toast(`Removido: ${r.removed.join(', ') || '(nada)'}`);
          if (state.selectedAsin === book.asin) {
            $('#readerEmpty').hidden = false;
            $('#readerBody').hidden = true;
            state.selectedAsin = null;
          }
          await loadStatus();
        } catch (e) { toast('Erro: ' + e.message, 'err'); }
      }
    );
  }

  // ---- cookies modal ----
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

  $('#cookiesSave').addEventListener('click', async () => {
    try {
      const cookies = parseCookiesInput();
      setCookieStatus('Salvando…', 'info');
      const r = await api('/api/cookies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cookies)
      });
      setCookieStatus(`✓ ${r.count} cookies salvos. Cookies de sessão encontrados: <code>${r.sessionCookiesFound.join(', ')}</code>`, 'ok');
      loadStatus();
    } catch (e) {
      setCookieStatus('✗ ' + e.message, 'err');
    }
  });

  $('#cookiesValidate').addEventListener('click', async () => {
    try {
      const cookies = parseCookiesInput();
      setCookieStatus('Salvando e testando login (pode levar 10s)…', 'info');
      await api('/api/cookies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cookies)
      });
      const r = await api('/api/check-login', { method: 'POST' });
      if (r.ok) {
        setCookieStatus(`✓ Login OK! Livros detectados na biblioteca: <b>${r.booksDetected || '?'}</b>. URL: <code>${r.url}</code>`, 'ok');
      } else {
        setCookieStatus(`✗ ${r.error || 'falhou'}. URL final: <code>${r.url}</code>`, 'err');
      }
      loadStatus();
    } catch (e) {
      setCookieStatus('✗ ' + e.message, 'err');
    }
  });

  // ---- reset book (botão no leitor) ----
  $('#btnReset').addEventListener('click', () => {
    if (!state.selectedAsin) return;
    const b = state.books.find(x => x.asin === state.selectedAsin);
    if (b) confirmReset(b);
  });

  // ---- handlers ----
  $('#btnStart').addEventListener('click', async () => {
    try {
      await api('/api/start', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
      toast('Extração iniciada');
    } catch (e) { toast('Erro: ' + e.message, 'err'); }
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

  // ---- init ----
  loadStatus();
  connectSSE();
  setInterval(loadStatus, 6000); // refresh sizes etc
})();
