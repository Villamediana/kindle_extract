# kindle_extract

> Extrai o texto dos seus próprios livros do **Kindle Cloud Reader** — sem VNC, sem display gráfico, sem PC local rodando nada durante a extração. Tudo headless, num servidor só.

Você comprou os livros. Eles são seus. Esta ferramenta apenas te devolve o texto deles num arquivo que você pode ler, buscar, citar e alimentar em qualquer pipeline pessoal (RAG, anotações, ebook reader próprio, o que for).

---

## Por que isso é menos trivial do que parece

O Kindle Cloud Reader migrou para o modo `kr-fullpage-document`: cada página agora vem **renderizada como imagem** (`<img src="blob:...">`) e o Amazon bloqueia `fetch` / `XHR` em cima do blob URL. Ctrl+A e clipboard também bloqueados. Não dá pra simplesmente raspar o HTML — não tem HTML de texto.

A única saída viável é tratar a página como o que ela virou: uma imagem.

```
   ┌──────────────────┐    captura      ┌─────────────┐   OCR (pt)   ┌────────────┐
   │  Kindle Cloud    │ ───canvas──────▶│   PNG tmp   │ ────────────▶│  livro.txt │
   │  Reader (blob)   │                 └─────────────┘   Tesseract  └────────────┘
   └────────┬─────────┘                                                     ▲
            │ vira próxima página em paralelo ──────────────────────────────┘
            ▼
       (pipeline async)
```

Pipeline assíncrono: a virada da próxima página acontece **enquanto** o OCR da anterior ainda está rodando. Tempo médio: **~5-9 segundos por página**. Fim do livro detectado quando o hash SHA-1 da imagem renderizada se repete (Kindle para de virar).

Estado de cada livro é salvo em `output/<titulo>.state.json` a cada página, então um crash, queda de SSH, ou kill no meio do processo é retomável.

---

## Stack

| Camada            | Tech                                       |
| ----------------- | ------------------------------------------ |
| Automação browser | Playwright (Chromium headless)             |
| OCR               | Tesseract (`--psm 3 --oem 1 -l por`)       |
| Server / UI       | Node + Express + SSE                       |
| Persistência      | arquivos `.txt` e `.state.json` por livro  |
| Autenticação      | cookies importados do seu browser pessoal  |

---

## Quickstart

```bash
git clone https://github.com/Villamediana/kindle_extract && cd kindle_extract
npm install
npm run setup       # checa/instala node, playwright, tesseract+pt, dirs
npm run server      # sobe UI em http://SEU_SERVIDOR:3400
```

`npm run setup` é idempotente — ele audita o ambiente e instala só o que falta:

- Node 18+
- Dependências do `package.json`
- Chromium do Playwright
- Tesseract + pacote de idioma português (via `apt` em Debian/Ubuntu)
- Diretórios de trabalho (`output/`, `tmp_ocr/`, `session/`, …)

No primeiro `apt-get` ele pede `sudo`.

---

## Autenticação (cookies)

A Amazon não tem login por API, então autenticamos importando os cookies do seu browser pessoal:

1. No seu PC, instale [Cookie-Editor](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm) (Chrome/Brave/Edge).
2. Faça login normal em **read.amazon.com**.
3. Ícone da extensão → **Export → Export as JSON**.
4. No dashboard (`http://SEU_SERVIDOR:3400`), clique em **Cookies** → cole o JSON → **Validar & testar login**.

O sistema valida o JSON, confere a presença dos cookies obrigatórios (`at-main`, `sess-at-main`, `x-main`, `ubid-main`, `session-id`), salva em `cookies.json` e abre o Kindle uma vez pra confirmar que a sessão está válida.

> A sessão da Amazon expira a cada poucas semanas. Quando acontecer, basta repetir o passo 4.

---

## Lista de livros

Edite `config.json` (use `config.example.json` como base):

```json
{
  "books": [
    { "asin": "B0752X3H64", "title": "Cartas de um diabo a seu aprendiz", "author": "Lewis, C. S." },
    { "asin": "B07V8LHWZ5", "title": "Hábitos Atômicos", "author": "Clear, James" }
  ],
  "settings": {
    "pageDelayMs": 1500,
    "headless": true
  }
}
```

O ASIN está na URL ao abrir o livro em `read.amazon.com` (`?asin=BXXXXXXX`). Ou rode `npm run list-library` que lista tudo automaticamente.

Campo opcional por livro: `maxPages` (limita páginas — útil pra testar).

---

## Uso

### Pela UI (recomendado)

```bash
npm run server                                  # foreground
# ou em background, sobrevive logout:
nohup npm run server > server.log 2>&1 &
```

Abra `http://SEU_SERVIDOR:3400`:

- **Topo** — contadores (livros, prontos, parciais, status dos cookies), iniciar/parar
- **Sidebar** — biblioteca com busca, filtros, bolinhas de status, reset por livro no hover
- **Ao vivo** — livro atual, página, caracteres extraídos, preview do texto saindo agora, tail do `.txt` se atualizando
- **Leitor** — lê o `.txt` com tipografia serif, tamanho ajustável, download
- **Logs** — stream colorido de eventos via SSE

### Pela CLI

```bash
npm run extract
```

---

## API

| Método | Rota                          | Descrição                                                |
| ------ | ----------------------------- | -------------------------------------------------------- |
| GET    | `/api/status`                 | livros + status, settings, se está rodando               |
| GET    | `/api/setup-status`           | health-check (node, playwright, tesseract, dirs)         |
| GET    | `/api/file/:name`             | conteúdo completo do `.txt`                              |
| GET    | `/api/file/:name/tail`        | últimos 4KB do `.txt`                                    |
| GET    | `/api/logs`                   | últimos 200 eventos                                      |
| GET    | `/api/events`                 | stream SSE de eventos ao vivo                            |
| POST   | `/api/start`                  | inicia extração — body opcional `{"asins":[...]}`        |
| POST   | `/api/stop`                   | para a extração atual                                    |
| POST   | `/api/cookies`                | salva cookies (body = array JSON da extensão)            |
| POST   | `/api/check-login`            | abre Kindle e valida que está logado                     |
| POST   | `/api/book/:asin/reset`       | apaga `.txt` + state do livro                            |

---

## Estrutura

```
kindle_extract/
├── public/                  UI estática (HTML + CSS + JS)
├── src/
│   ├── server.js            Express + SSE (porta 3400)
│   ├── extract.js           Playwright + Tesseract (pipeline async)
│   ├── setup.js             health-check / installer
│   ├── login.js             validação de cookies via CLI
│   ├── list_library.js      lista os livros disponíveis
│   ├── clean.js             normalização pós-OCR
│   └── inspect_reader.js    debug: dumpa HTML/screenshots do reader
├── output/                  .txt + .state.json (gitignored)
├── tmp_ocr/                 PNGs temporários (gitignored, auto-limpo)
├── session/                 perfil do Chromium (gitignored)
├── cookies.json             (gitignored)
├── config.json              sua lista de livros (gitignored)
└── config.example.json
```

---

## Troubleshooting

**"Cookies não autenticaram"** — sessão expirou ou exportou do domínio errado. Reexporte os cookies (precisa estar logado no momento da exportação) e cole de novo.

**"Tesseract não instalado"** — `npm run setup` resolve via `apt-get` em Debian/Ubuntu. Em outros OS:
- macOS: `brew install tesseract tesseract-lang`
- Fedora: `sudo dnf install tesseract tesseract-langpack-por`

**OCR lento (>15s/página)** — provavelmente a imagem está muito grande. O default `--psm 3 --oem 1 -l por` é o que dá melhor relação custo/qualidade.

**Texto com colunas embaralhadas** — raro com `--psm 3` (auto layout), mas se acontecer, edite `src/extract.js` e teste `--psm 1` (mais lento, usa OSD).

**Página só tem chrome do Kindle ("Page X of Y…")** — a página não terminou de renderizar antes da captura. Aumente `pageDelayMs` em `config.json`.

**Quero rodar de novo em livro já completo** — use o reset (UI ou `POST /api/book/:asin/reset`), porque o sistema pula livros marcados como `completed`.

---

## Notas

- 100% headless. Sem display gráfico. Roda numa VPS sem X11.
- O Cloud Reader muda de tempos em tempos (já mudou de "reflowable" pra "fullpage"). Se quebrar, `node src/inspect_reader.js B0XXXXXXX` dumpa a estrutura atual pra debug.
- Os PNGs intermediários ficam em `tmp_ocr/<asin>/` durante a extração e são apagados ao final de cada livro.
- A porta 3400 precisa estar liberada no firewall (ufw/iptables) e no security group do provedor, se houver.

---

## Sobre direitos

Este projeto **não baixa, não distribui e não desprotege DRM** de livros que não são seus. Ele acessa o conteúdo via o leitor oficial da Amazon, autenticado com a sua própria conta, e extrai o texto que você já tem direito de ler. É o equivalente digital de transcrever trechos de um livro físico que você comprou.

Se você não comprou o livro, esta ferramenta não te dá acesso a ele.
