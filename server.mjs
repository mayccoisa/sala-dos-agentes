// Sala dos Agentes — Fases 1 + 2 + 3 (PRD "Sala dos Agentes")
// Servidor local de arquivo único: lê os transcripts JSONL que o Claude Code
// já grava em disco e serve uma "salinha" viva mostrando o que cada agente faz,
// QUEM chamou QUEM (fluxo em árvore + sala pixel-art animada) e a linha do
// tempo dos handoffs. Personagens: pack CC0 "Roguelike Characters" da Kenney
// (kenney.nl) — ver assets/CREDITS.txt.
// Zero dependências (só o Node embutido) e ZERO token de API — só LÊ logs.
//
// Uso:
//   node server.mjs            # detecta o projeto doc-hub + sessão mais recente
//   node server.mjs <sessionId># fixa uma sessão específica
//   PORT=4599 node server.mjs  # troca a porta
//   AGENT_ROOM_PROJECT=<pasta|caminho> node ... # força o projeto (outro PC/caminho)
//
// Depois abra http://localhost:4599 no navegador.
// Não precisa de npm install nem de configurar caminho: acha os logs sozinho.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 4599;
const FIXED_SESSION = process.argv[2] || null;
const STALE_MS = 90_000; // sem atividade por 90s => ocioso

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPRITE_SHEET = path.join(HERE, 'assets', 'characters.png');

// Diretório onde o Claude Code grava os transcripts deste projeto.
// Portátil: funciona em qualquer PC sem editar nada.
//  1. Se AGENT_ROOM_PROJECT estiver setada, usa ela (caminho absoluto OU nome
//     da pasta em ~/.claude/projects).
//  2. Senão, procura em ~/.claude/projects a pasta que contenha "doc-hub".
//  3. Fallback: a pasta com o .jsonl mais recente (qualquer projeto).
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

function newestJsonlMtime(dir) {
  let m = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const t = fs.statSync(path.join(dir, f)).mtimeMs;
      if (t > m) m = t;
    }
  } catch {
    /* ignora */
  }
  return m;
}

function resolveProjectDir() {
  const override = process.env.AGENT_ROOM_PROJECT;
  if (override) {
    return path.isAbsolute(override)
      ? override
      : path.join(PROJECTS_ROOT, override);
  }
  let subdirs = [];
  try {
    subdirs = fs
      .readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(PROJECTS_ROOT, d.name));
  } catch {
    return path.join(PROJECTS_ROOT, 'C--proj-doc-hub'); // melhor esforço
  }
  const byName = subdirs.filter((d) => /doc-hub/i.test(path.basename(d)));
  const pool = byName.length ? byName : subdirs;
  let best = pool[0];
  let bestM = -1;
  for (const d of pool) {
    const m = newestJsonlMtime(d);
    if (m > bestM) {
      bestM = m;
      best = d;
    }
  }
  return best || path.join(PROJECTS_ROOT, 'C--proj-doc-hub');
}

const PROJECT_DIR = resolveProjectDir();

// ---- Elenco: papel -> avatar + cor + nome amigável ------------------------
// Papéis vêm de .claude/agents/. "orquestrador" é a sessão principal (main loop).
const ROLES = {
  orquestrador: { emoji: '🧠', name: 'Orquestrador', color: '#6366f1' },
  pm: { emoji: '🧭', name: 'PM', color: '#2563eb' },
  pesquisador: { emoji: '🔎', name: 'Pesquisador', color: '#0891b2' },
  po: { emoji: '📋', name: 'PO', color: '#7c3aed' },
  designer: { emoji: '🎨', name: 'Designer', color: '#db2777' },
  'lead-design': { emoji: '🧩', name: 'Lead Design', color: '#c026d3' },
  pa: { emoji: '📊', name: 'PA', color: '#059669' },
  qa: { emoji: '✅', name: 'QA', color: '#16a34a' },
  'pos-release': { emoji: '📣', name: 'Pós-Release', color: '#ea580c' },
  'cs-implantacao': { emoji: '🤝', name: 'CS / Implantação', color: '#d97706' },
  // utilitários genéricos que o main também aciona
  Explore: { emoji: '🗺️', name: 'Explore', color: '#64748b' },
  Plan: { emoji: '📐', name: 'Plan', color: '#64748b' },
  'general-purpose': { emoji: '🛠️', name: 'Generalista', color: '#64748b' },
  claude: { emoji: '🤖', name: 'Claude', color: '#64748b' },
};
const roleMeta = (t) =>
  ROLES[t] || { emoji: '🧑‍💻', name: t || 'Agente', color: '#64748b' };

// ---- Tradução de ferramenta -> "o que está fazendo" -----------------------
function friendlyTool(name = '') {
  const n = String(name);
  if (n === 'Agent') return { verb: 'delegando trabalho', tag: 'delega' };
  if (n === 'WebSearch' || n === 'WebFetch')
    return { verb: 'pesquisando na web', tag: 'pesquisa' };
  if (n === 'Read' || n === 'Grep' || n === 'Glob')
    return { verb: 'lendo o código', tag: 'lê' };
  if (n === 'Edit' || n === 'Write' || n === 'NotebookEdit')
    return { verb: 'editando arquivos', tag: 'edita' };
  if (n === 'Bash' || n === 'PowerShell')
    return { verb: 'rodando comandos', tag: 'shell' };
  if (n.includes('create_doc') || n.includes('update_doc'))
    return { verb: 'escrevendo documento', tag: 'doc' };
  if (n.includes('figma')) return { verb: 'mexendo no Figma', tag: 'figma' };
  if (n.startsWith('mcp__')) {
    const short = n.split('__').pop();
    return { verb: `usando ${short}`, tag: 'mcp' };
  }
  return { verb: `usando ${n}`, tag: 'tool' };
}

// ---- Leitura tolerante de JSONL -------------------------------------------
function readLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}
function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
function safeMtime(f) {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}
function contentBlocks(d) {
  const c = d && d.message && d.message.content;
  return Array.isArray(c) ? c : [];
}

// Últimos N eventos que têm message.content (ignora heartbeats/queue-ops).
function lastContentEvents(lines, n = 6) {
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const d = parse(lines[i]);
    if (d && d.message && d.message.content) out.push(d);
  }
  return out; // mais recente primeiro
}

// Descreve o estado a partir do evento mais recente com conteúdo.
function describe(events) {
  const last = events[0];
  if (!last) return { status: 'idle', doing: 'ocioso', tag: null };
  const blocks = contentBlocks(last);
  const toolUse = blocks.find((b) => b && b.type === 'tool_use');
  if (last.message.role === 'assistant' && toolUse) {
    if (toolUse.name === 'Agent' && toolUse.input && toolUse.input.subagent_type) {
      const target = roleMeta(toolUse.input.subagent_type);
      return { status: 'working', doing: `delegando p/ ${target.name}`, tag: 'delega' };
    }
    const f = friendlyTool(toolUse.name);
    return { status: 'working', doing: f.verb, tag: f.tag };
  }
  if (last.message.role === 'assistant')
    return { status: 'thinking', doing: 'pensando / escrevendo', tag: 'pensa' };
  return { status: 'working', doing: 'processando resultado', tag: 'proc' };
}

// Extrai de um arquivo: spawns (blocos Agent) e ids de tool_result concluídos.
function scanFile(lines) {
  const spawns = [];
  const resultIds = new Set();
  for (const line of lines) {
    const d = parse(line);
    if (!d) continue;
    for (const b of contentBlocks(d)) {
      if (b && b.type === 'tool_use' && b.name === 'Agent' && b.input) {
        spawns.push({
          id: b.id,
          to: b.input.subagent_type || 'claude',
          description: b.input.description || '',
          ts: d.timestamp || null,
        });
      }
      if (b && b.type === 'tool_result' && b.tool_use_id)
        resultIds.add(b.tool_use_id);
    }
  }
  return { spawns, resultIds };
}

// ---- Descobre a sessão ativa ----------------------------------------------
function activeSession(dir) {
  let best = null;
  let bestMtime = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = f.replace(/\.jsonl$/, '');
      }
    }
  } catch {
    /* diretório ausente */
  }
  return best;
}

// Lê o começo de um arquivo (sem carregar 14 MB) para achar o cwd real.
function readPrefix(file, bytes = 8192) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  }
}

// Caminho de trabalho real gravado nos logs (ex.: "C:\\proj\\doc-hub").
function projectCwd(dir) {
  let newest = null;
  let m = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const t = fs.statSync(path.join(dir, f)).mtimeMs;
      if (t > m) { m = t; newest = f; }
    }
  } catch {
    return null;
  }
  if (!newest) return null;
  const prefix = readPrefix(path.join(dir, newest));
  const match = prefix.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  try {
    return JSON.parse('"' + match[1] + '"');
  } catch {
    return match[1];
  }
}

// Lista os projetos disponíveis para o seletor da UI.
function listProjects() {
  let subdirs = [];
  try {
    subdirs = fs
      .readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const defBase = path.basename(PROJECT_DIR);
  return subdirs
    .map((folder) => {
      const dir = path.join(PROJECTS_ROOT, folder);
      const cwd = projectCwd(dir);
      const last = newestJsonlMtime(dir);
      let sessions = 0;
      try {
        sessions = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.jsonl')).length;
      } catch {
        /* ignora */
      }
      return {
        folder,
        label: cwd || folder,
        name: cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) : folder,
        lastActive: last,
        sessions,
        isDefault: folder === defBase,
      };
    })
    .filter((p) => p.sessions > 0)
    .sort((a, b) => b.lastActive - a.lastActive);
}

// ---- Monta o estado da sala -----------------------------------------------
function buildState(projectDir, fixedSession) {
  const dir = projectDir || PROJECT_DIR;
  const sessionId = fixedSession || activeSession(dir);
  const now = Date.now();
  if (!sessionId)
    return { sessionId: null, agents: [], edges: [], timeline: [], ts: now };

  const mainFile = path.join(dir, `${sessionId}.jsonl`);
  const mainLines = readLines(mainFile);
  const mainScan = scanFile(mainLines);

  // Lê os metas dos subagentes: filename <-> {agentType, toolUseId, ...}
  const subDir = path.join(dir, sessionId, 'subagents');
  let metaFiles = [];
  try {
    metaFiles = fs.readdirSync(subDir).filter((f) => f.endsWith('.meta.json'));
  } catch {
    metaFiles = [];
  }
  const metas = metaFiles.map((mf) => {
    const meta = parse(readLines(path.join(subDir, mf)).join('')) || {};
    return {
      metaId: mf,
      jsonl: path.join(subDir, mf.replace(/\.meta\.json$/, '.jsonl')),
      type: meta.agentType || 'claude',
      description: meta.description || '',
      toolUseId: meta.toolUseId || null,
      depth: meta.spawnDepth || 1,
    };
  });

  // spawnByToolUseId: quem gerou cada toolUseId (pai) + quando + p/ quem.
  // Fonte main => pai = orquestrador. Fonte subagente => pai = aquele subagente.
  const spawnBy = {};
  const finishedIds = new Set(mainScan.resultIds);
  for (const s of mainScan.spawns)
    spawnBy[s.id] = { ...s, parentId: 'orquestrador', parentRole: 'orquestrador' };
  for (const m of metas) {
    const scan = scanFile(readLines(m.jsonl));
    for (const id of scan.resultIds) finishedIds.add(id);
    for (const s of scan.spawns)
      spawnBy[s.id] = { ...s, parentId: m.metaId, parentRole: m.type };
  }

  // ---- Roster de agentes -------------------------------------------------
  const agents = [];
  const mainMtime = safeMtime(mainFile);
  const mainState = describe(lastContentEvents(mainLines));
  const mainStale = now - mainMtime > STALE_MS;
  agents.push({
    id: 'orquestrador',
    parentId: null,
    type: 'orquestrador',
    ...roleMeta('orquestrador'),
    description: 'sessão principal',
    status: mainStale ? 'idle' : mainState.status,
    doing: mainStale ? 'ocioso' : mainState.doing,
    tag: mainStale ? null : mainState.tag,
    lastActiveSecs: Math.round((now - mainMtime) / 1000),
    depth: 0,
  });

  for (const m of metas) {
    const mtime = safeMtime(m.jsonl);
    const done = m.toolUseId && finishedIds.has(m.toolUseId);
    const st = describe(lastContentEvents(readLines(m.jsonl)));
    const stale = now - mtime > STALE_MS;
    const spawn = m.toolUseId && spawnBy[m.toolUseId];
    agents.push({
      id: m.metaId,
      parentId: spawn ? spawn.parentId : 'orquestrador',
      type: m.type,
      ...roleMeta(m.type),
      description: m.description,
      status: done ? 'done' : stale ? 'idle' : st.status,
      doing: done ? 'concluído' : stale ? 'aguardando' : st.doing,
      tag: done ? 'ok' : stale ? null : st.tag,
      lastActiveSecs: Math.round((now - mtime) / 1000),
      depth: m.depth,
    });
  }

  // ---- Arestas (para o desenho da árvore) --------------------------------
  const idOf = new Map(agents.map((a) => [a.id, a]));
  const edges = agents
    .filter((a) => a.parentId && idOf.has(a.parentId))
    .map((a) => ({
      from: a.parentId,
      to: a.id,
      active: a.status === 'working' || a.status === 'thinking',
    }));

  // ---- Linha do tempo dos handoffs ---------------------------------------
  const timeline = Object.values(spawnBy)
    .map((s) => ({
      ts: s.ts,
      from: s.parentRole,
      to: s.to,
      description: s.description,
      done: finishedIds.has(s.id),
    }))
    .filter((t) => t.ts)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  return { sessionId, agents, edges, timeline, ts: now };
}

// ---- HTTP -----------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const json = (obj) => {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === '/projects') {
    json({ projects: listProjects(), defaultFolder: path.basename(PROJECT_DIR) });
    return;
  }
  if (url.pathname === '/state') {
    // Projeto escolhido na UI vence; senão usa o auto-detectado (+ FIXED_SESSION).
    const projParam = url.searchParams.get('project');
    const dir = projParam ? path.join(PROJECTS_ROOT, projParam) : PROJECT_DIR;
    const fixed = projParam ? null : FIXED_SESSION;
    json(buildState(dir, fixed));
    return;
  }
  if (req.url && req.url.startsWith('/characters.png')) {
    try {
      const png = fs.readFileSync(SPRITE_SHEET);
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'max-age=3600',
      });
      res.end(png);
    } catch {
      res.writeHead(404);
      res.end('spritesheet ausente');
    }
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HTML);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE')
    console.error(`\n  ⚠ Porta ${PORT} já em uso. Feche a outra Sala ou use PORT=<n>.\n`);
  else console.error('  ⚠ Erro no servidor:', err.message);
});
server.listen(PORT, () => {
  console.log(`\n  🏠 Sala dos Agentes rodando em  http://localhost:${PORT}`);
  console.log(`     lendo: ${PROJECT_DIR}`);
  console.log(`     (zero token de API — só lê os logs locais)\n`);
});

// ---- Página (embutida) ----------------------------------------------------
const HTML = /* html */ `<!doctype html>
<html lang="pt-BR" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sala dos Agentes</title>
<style>
  :root{
    --bg:#0b0d12; --panel:#141821; --panel2:#1b2230; --line:#252c3a;
    --text:#e7ecf3; --muted:#8b96a8; --idle:#3a4356;
    --ok:#16a34a; --work:#f59e0b; --think:#38bdf8;
    --floor:#151b26; --floor2:#111722;
  }
  :root[data-theme="light"]{
    --bg:#f4f6fb; --panel:#ffffff; --panel2:#eef2f9; --line:#e2e8f2;
    --text:#0f172a; --muted:#64748b; --idle:#cbd5e1;
    --ok:#16a34a; --work:#d97706; --think:#0284c7;
    --floor:#eef2f9; --floor2:#e6ecf6;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  header{display:flex;align-items:center;gap:12px;padding:16px 22px;
    border-bottom:1px solid var(--line)}
  header h1{font-size:16px;margin:0;font-weight:650;letter-spacing:.2px}
  .sub{color:var(--muted);font-size:12.5px}
  .spacer{flex:1}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--ok);
    box-shadow:0 0 0 0 rgba(22,163,74,.5);animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(22,163,74,.5)}
    70%{box-shadow:0 0 0 7px rgba(22,163,74,0)}100%{box-shadow:0 0 0 0 rgba(22,163,74,0)}}
  .seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}
  .seg button{background:var(--panel);color:var(--muted);border:0;padding:6px 12px;
    cursor:pointer;font-size:13px}
  .seg button.active{background:var(--panel2);color:var(--text)}
  button.theme{background:var(--panel2);color:var(--text);border:1px solid var(--line);
    border-radius:8px;padding:6px 10px;cursor:pointer;font-size:13px}
  select.proj{background:var(--panel2);color:var(--text);border:1px solid var(--line);
    border-radius:8px;padding:6px 10px;font-size:13px;max-width:230px;cursor:pointer}
  main{padding:20px;max-width:1120px;margin:0 auto}
  h2.sec{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);
    margin:22px 2px 10px}
  .hidden{display:none}
  /* sala pixel */
  .roomwrap{background:var(--panel);border:1px solid var(--line);border-radius:14px;
    padding:10px;overflow:auto}
  #room{display:block;image-rendering:pixelated}
  /* diagrama (fase 2) */
  .flowwrap{background:var(--panel);border:1px solid var(--line);border-radius:14px;
    padding:14px;overflow:auto}
  .stage{position:relative}
  .stage svg{position:absolute;inset:0;overflow:visible;pointer-events:none}
  .node{position:absolute;width:180px;height:58px;background:var(--panel2);
    border:1px solid var(--line);border-radius:12px;padding:8px 10px;display:flex;
    align-items:center;gap:9px;transition:border-color .2s,box-shadow .2s}
  .node.on{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
  .node .ava{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;
    font-size:18px;background:var(--panel);border:1px solid var(--line);flex:none}
  .node.on .ava{background:color-mix(in srgb,var(--accent) 20%,var(--panel))}
  .node .nm{font-weight:640;font-size:13px;line-height:1.15}
  .node .dg{color:var(--muted);font-size:11px;margin-top:2px;display:flex;align-items:center;gap:5px}
  .node.idle{opacity:.6}
  .st{width:8px;height:8px;border-radius:50%;flex:none;background:var(--idle)}
  .st.working{background:var(--work)} .st.thinking{background:var(--think)}
  .st.done{background:var(--ok)} .st.idle{background:var(--idle)}
  .st.working,.st.thinking{animation:blink 1.3s infinite}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
  path.link{fill:none;stroke:var(--line);stroke-width:2}
  path.link.on{stroke:var(--work);stroke-width:2.4;stroke-dasharray:6 6;
    animation:flow 1s linear infinite}
  @keyframes flow{to{stroke-dashoffset:-24}}
  .empty{color:var(--muted);font-size:13px;padding:8px 2px}
  /* timeline */
  .tl{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
  .tl .item{display:flex;align-items:center;gap:10px;padding:10px 14px;
    border-top:1px solid var(--line);font-size:13px}
  .tl .item:first-child{border-top:none}
  .tl .time{color:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums;width:56px;flex:none}
  .tl .who{display:inline-flex;align-items:center;gap:6px}
  .arrow{color:var(--muted)}
  .tl .desc{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .badge{margin-left:auto;font-size:11px;padding:2px 8px;border-radius:999px;
    border:1px solid var(--line);flex:none}
  .badge.live{color:var(--work);border-color:var(--work)}
  .badge.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 60%,var(--line))}
  /* roster */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px}
  .card .r{display:flex;align-items:center;gap:9px}
  .card .ava{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;
    font-size:19px;background:var(--panel2);border:1px solid var(--line);flex:none}
  .card .nm{font-weight:620;font-size:14px}
  .card .dc{color:var(--muted);font-size:11.5px;max-width:150px;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}
  .card .doing{margin-top:10px;display:flex;align-items:center;gap:8px;font-size:12.5px}
  .pill{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);
    color:var(--muted)}
  .secs{margin-left:auto;color:var(--muted);font-size:11px}
  .card.idle{opacity:.6}
</style>
</head>
<body>
<header>
  <span class="dot"></span>
  <div><h1>Sala dos Agentes</h1><div class="sub" id="session">conectando…</div></div>
  <div class="spacer"></div>
  <select class="proj" id="proj" title="Projeto a observar"></select>
  <div class="seg" id="seg">
    <button data-view="room" class="active">🏠 Sala</button>
    <button data-view="diagram">🌳 Diagrama</button>
  </div>
  <button class="theme" id="theme">☀︎ / ☾</button>
</header>
<main>
  <div id="viewRoom">
    <h2 class="sec">Sala — a equipe trabalhando</h2>
    <div class="roomwrap"><canvas id="room" width="900" height="360"></canvas></div>
  </div>
  <div id="viewDiagram" class="hidden">
    <h2 class="sec">Fluxo — quem chamou quem</h2>
    <div class="flowwrap"><div class="stage" id="stage"></div></div>
  </div>

  <h2 class="sec">Linha do tempo dos handoffs</h2>
  <div class="tl" id="timeline"></div>

  <h2 class="sec">Agentes</h2>
  <div class="grid" id="grid"></div>
</main>
<script>
  // ---- sprites (Kenney Roguelike Characters, CC0) -----------------------
  var TILE = 16, STRIDE = 17;
  // papel -> [coluna, linha] no spritesheet. Humanos linhas 5-11; criaturas 0-3.
  var SPRITE = {
    orquestrador:[1,5], pm:[1,6], pesquisador:[1,8], po:[0,7], pa:[1,9],
    designer:[0,5], 'lead-design':[0,10], qa:[0,9], 'pos-release':[1,10],
    'cs-implantacao':[0,6],
    Explore:[0,3], Plan:[0,2], 'general-purpose':[0,1], claude:[0,0]
  };
  var FALLBACK = [1,7];
  var sheet = new Image(); var sheetReady = false;
  sheet.onload = function(){ sheetReady = true; };
  sheet.src = '/characters.png';

  var S = { agents:[], edges:[], timeline:[], sessionId:null };
  var view = 'room';
  var DESK_ORDER = ['orquestrador','pesquisador','pm','po','pa','designer',
    'lead-design','qa','pos-release','cs-implantacao'];

  var canvas = document.getElementById('room');
  var ctx = canvas.getContext('2d');
  var stage = document.getElementById('stage');
  var tl = document.getElementById('timeline');
  var grid = document.getElementById('grid');
  var sess = document.getElementById('session');

  document.getElementById('theme').onclick = function(){
    var r = document.documentElement;
    r.dataset.theme = r.dataset.theme === 'dark' ? 'light' : 'dark';
  };
  document.getElementById('seg').addEventListener('click', function(e){
    var b = e.target.closest('button'); if(!b) return;
    view = b.dataset.view;
    Array.prototype.forEach.call(this.children, function(c){
      c.classList.toggle('active', c === b); });
    document.getElementById('viewRoom').classList.toggle('hidden', view!=='room');
    document.getElementById('viewDiagram').classList.toggle('hidden', view!=='diagram');
  });

  function cssVar(n){ return getComputedStyle(document.documentElement)
    .getPropertyValue(n).trim(); }
  function ago(s){ return s<5?'agora':s<60?s+'s':Math.round(s/60)+'min'; }
  function hhmm(ts){ try{ var d=new Date(ts);
    return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);
    }catch(e){ return ''; } }
  function agentBy(id){ for(var i=0;i<S.agents.length;i++)
    if(S.agents[i].id===id) return S.agents[i]; return null; }
  function roleName(role){ for(var i=0;i<S.agents.length;i++)
    if(S.agents[i].type===role) return S.agents[i].name; return role; }
  function roleEmoji(role){ for(var i=0;i<S.agents.length;i++)
    if(S.agents[i].type===role) return S.agents[i].emoji; return '🧑‍💻'; }
  function statusColor(st){ return st==='working'?cssVar('--work')
    : st==='thinking'?cssVar('--think') : st==='done'?cssVar('--ok') : cssVar('--idle'); }

  // ---- layout da sala ---------------------------------------------------
  function layout(agents){
    var byDepth = {};
    agents.forEach(function(a){ (byDepth[a.depth]=byDepth[a.depth]||[]).push(a); });
    var startX=95, colW=185, startY=90, rowH=112, pos={}, maxB=startY, maxR=startX;
    Object.keys(byDepth).map(Number).sort(function(a,b){return a-b;}).forEach(function(d){
      byDepth[d].forEach(function(a,i){
        var x=startX+d*colW, y=startY+i*rowH; pos[a.id]={x:x,y:y};
        if(y>maxB)maxB=y; if(x>maxR)maxR=x;
      });
    });
    return { pos:pos, w:maxR+130, h:maxB+80 };
  }

  function roundRect(x,y,w,h,r){
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
  }

  function drawFloor(w,h){
    ctx.fillStyle = cssVar('--floor'); ctx.fillRect(0,0,w,h);
    ctx.fillStyle = cssVar('--floor2');
    var s=26;
    for(var y=0;y<h;y+=s) for(var x=0;x<w;x+=s)
      if(((x/s)+(y/s))%2===0) ctx.fillRect(x,y,s,s);
    ctx.strokeStyle = cssVar('--line'); ctx.lineWidth=1;
    ctx.globalAlpha=.5; ctx.strokeRect(.5,.5,w-1,h-1); ctx.globalAlpha=1;
  }

  function drawEdge(p,c,active,t,color){
    var y1=p.y-24, y2=c.y-24, x1=p.x+18, x2=c.x-18;
    ctx.save();
    ctx.lineWidth = active?2.4:1.5;
    ctx.strokeStyle = active?cssVar('--work'):cssVar('--line');
    ctx.globalAlpha = active?1:.5;
    if(active){ ctx.setLineDash([6,6]); ctx.lineDashOffset = -(t/28)%1000; }
    var mx=(x1+x2)/2;
    ctx.beginPath(); ctx.moveTo(x1,y1);
    ctx.bezierCurveTo(mx,y1,mx,y2,x2,y2); ctx.stroke();
    ctx.restore();
    if(active){
      var pr=(t/1400)%1;
      var tx=x1+(x2-x1)*pr, ty=y1+(y2-y1)*pr;
      ctx.fillStyle=color||cssVar('--work');
      ctx.shadowColor=color||cssVar('--work'); ctx.shadowBlur=8;
      ctx.beginPath(); ctx.arc(tx,ty,4,0,7); ctx.fill();
      ctx.shadowBlur=0;
    }
  }

  function bubble(cx, bottomY, text){
    if(text.length>28) text = text.slice(0,27)+'…';
    ctx.font = '600 11px ui-sans-serif,system-ui';
    var w = ctx.measureText(text).width + 16, h = 20;
    var x = cx - w/2, y = bottomY - h - 6;
    ctx.fillStyle = cssVar('--panel2');
    ctx.strokeStyle = cssVar('--line'); ctx.lineWidth=1;
    roundRect(x,y,w,h,7); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx-5,y+h); ctx.lineTo(cx+5,y+h);
    ctx.lineTo(cx,y+h+5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = cssVar('--text'); ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(text, cx, y+h/2+1);
  }

  function drawAgent(a,p,t){
    var active = a.status==='working' || a.status==='thinking';
    var scale=3, size=TILE*scale;
    var cx=p.x, feet=p.y;
    var bob = active ? Math.sin(t/180 + p.x)*2.2 : Math.sin(t/700 + p.x)*1;
    // sombra
    ctx.fillStyle='rgba(0,0,0,.22)';
    ctx.beginPath(); ctx.ellipse(cx, feet+3, 18, 6, 0, 0, 7); ctx.fill();
    // aura de status quando ativo
    if(active){
      ctx.save(); ctx.globalAlpha=.16 + .06*Math.sin(t/300);
      ctx.fillStyle=statusColor(a.status);
      ctx.beginPath(); ctx.arc(cx, feet-size/2, size*0.7, 0, 7); ctx.fill();
      ctx.restore();
    }
    // sprite
    var sp = SPRITE[a.type] || FALLBACK;
    var sx = sp[0]*STRIDE, sy = sp[1]*STRIDE;
    var dx = cx - size/2, dy = feet - size - bob;
    ctx.save();
    if(a.status==='idle' || a.status==='done') ctx.globalAlpha=.55;
    if(sheetReady) ctx.drawImage(sheet, sx,sy,TILE,TILE, dx,dy, size,size);
    else { ctx.fillStyle=a.color; roundRect(dx,dy,size,size,6); ctx.fill(); }
    ctx.restore();
    // ponto de status
    ctx.fillStyle=statusColor(a.status);
    ctx.beginPath(); ctx.arc(cx+size/2-4, dy+6, 5, 0, 7); ctx.fill();
    ctx.strokeStyle=cssVar('--panel'); ctx.lineWidth=1.5; ctx.stroke();
    // nome
    ctx.fillStyle=cssVar('--text'); ctx.textAlign='center'; ctx.textBaseline='alphabetic';
    ctx.font='650 12px ui-sans-serif,system-ui'; ctx.fillText(a.name, cx, feet+20);
    // balão do que está fazendo
    if(active && a.doing) bubble(cx, dy, a.doing);
    else if(a.status==='done'){ ctx.fillStyle=cssVar('--muted');
      ctx.font='11px ui-sans-serif'; ctx.fillText('✓ concluído', cx, feet+34); }
  }

  function drawRoom(t){
    if(view==='room'){
      var L = layout(S.agents);
      var wrap = canvas.parentElement;
      var cssW = Math.max(wrap.clientWidth-20, L.w);
      var cssH = Math.max(320, L.h);
      var dpr = window.devicePixelRatio || 1;
      if(canvas.width!==Math.round(cssW*dpr) || canvas.height!==Math.round(cssH*dpr)){
        canvas.width=Math.round(cssW*dpr); canvas.height=Math.round(cssH*dpr);
        canvas.style.width=cssW+'px'; canvas.style.height=cssH+'px';
      }
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.imageSmoothingEnabled=false;
      drawFloor(cssW,cssH);
      S.edges.forEach(function(e){ var p=L.pos[e.from], c=L.pos[e.to];
        if(p&&c){ var to=agentBy(e.to); drawEdge(p,c,e.active,t, to?to.color:null); } });
      S.agents.forEach(function(a){ var p=L.pos[a.id]; if(p) drawAgent(a,p,t); });
    }
    requestAnimationFrame(drawRoom);
  }
  requestAnimationFrame(drawRoom);

  // ---- diagrama (fase 2) ------------------------------------------------
  var N_W=180,N_H=58,C_W=250,R_H=80,PAD=8;
  function renderFlow(agents){
    var byDepth={}; agents.forEach(function(a){(byDepth[a.depth]=byDepth[a.depth]||[]).push(a);});
    var pos={}, maxRows=1, maxDepth=0;
    Object.keys(byDepth).forEach(function(d){ maxDepth=Math.max(maxDepth,+d);
      byDepth[d].forEach(function(a,i){ pos[a.id]={x:PAD+(+d)*C_W,y:PAD+i*R_H};
        maxRows=Math.max(maxRows,byDepth[d].length); }); });
    var W=PAD*2+(maxDepth+1)*C_W-(C_W-N_W), H=PAD*2+maxRows*R_H-(R_H-N_H);
    stage.style.width=W+'px'; stage.style.height=H+'px';
    var paths='';
    agents.forEach(function(a){ if(!a.parentId||!pos[a.parentId])return;
      var p=pos[a.parentId], c=pos[a.id];
      var x1=p.x+N_W,y1=p.y+N_H/2,x2=c.x,y2=c.y+N_H/2,mx=(x1+x2)/2;
      var on=(a.status==='working'||a.status==='thinking');
      paths+='<path class="link '+(on?'on':'')+'" d="M '+x1+' '+y1+' C '+mx+' '+y1+', '+mx+' '+y2+', '+x2+' '+y2+'" />';
    });
    var nodes='';
    agents.forEach(function(a){ var p=pos[a.id];
      var on=(a.status==='working'||a.status==='thinking');
      nodes+='<div class="node '+(on?'on':'')+' '+(a.status==='idle'?'idle':'')+'" style="left:'+p.x+'px;top:'+p.y+'px;--accent:'+a.color+'" title="'+(a.doing||'')+'">'+
        '<div class="ava">'+a.emoji+'</div><div style="min-width:0"><div class="nm">'+a.name+'</div>'+
        '<div class="dg"><span class="st '+a.status+'"></span>'+a.doing+'</div></div></div>';
    });
    stage.innerHTML='<svg width="'+W+'" height="'+H+'">'+paths+'</svg>'+nodes;
  }

  function renderTimeline(t){
    if(!t.length){ tl.innerHTML='<div class="empty">nenhum handoff nesta sessão ainda.</div>'; return; }
    tl.innerHTML = t.slice().reverse().map(function(e){
      var badge = e.done?'<span class="badge ok">concluído</span>':'<span class="badge live">ativo</span>';
      return '<div class="item"><span class="time">'+hhmm(e.ts)+'</span>'+
        '<span class="who">'+roleEmoji(e.from)+' '+roleName(e.from)+'</span><span class="arrow">→</span>'+
        '<span class="who">'+roleEmoji(e.to)+' '+roleName(e.to)+'</span>'+
        '<span class="desc">— '+(e.description||'')+'</span>'+badge+'</div>';
    }).join('');
  }

  function renderRoster(agents){
    grid.innerHTML = agents.map(function(a){
      return '<div class="card '+(a.status==='idle'?'idle':'')+'" style="--accent:'+a.color+'">'+
        '<div class="r"><div class="ava">'+a.emoji+'</div><div style="min-width:0">'+
        '<div class="nm">'+a.name+'</div><div class="dc" title="'+(a.description||'')+'">'+(a.description||'—')+'</div></div></div>'+
        '<div class="doing"><span class="st '+a.status+'"></span><span>'+a.doing+'</span>'+
        (a.tag?'<span class="pill">'+a.tag+'</span>':'')+'<span class="secs">'+ago(a.lastActiveSecs)+'</span></div></div>';
    }).join('');
  }

  // ---- seletor de projeto ----------------------------------------------
  var proj = null; // pasta escolhida (null = auto-detectado no servidor)
  var projSel = document.getElementById('proj');
  function fmtAgo(ms){ if(!ms) return 'sem sessões';
    var s=Math.round((Date.now()-ms)/1000);
    return s<60?'agora há pouco':s<3600?Math.round(s/60)+'min atrás':
      s<86400?Math.round(s/3600)+'h atrás':Math.round(s/86400)+'d atrás'; }
  function loadProjects(){
    fetch('/projects').then(function(r){return r.json();}).then(function(d){
      var ps = d.projects || [];
      projSel.innerHTML = ps.map(function(p){
        var lbl = p.name + '  ·  ' + fmtAgo(p.lastActive);
        return '<option value="'+p.folder+'"'+(p.folder===d.defaultFolder?' selected':'')+'>'+lbl+'</option>';
      }).join('');
      proj = d.defaultFolder || (ps[0] && ps[0].folder) || null;
      if(ps.length<=1) projSel.style.display='none';
      tick();
    }).catch(function(){ tick(); });
  }
  projSel.addEventListener('change', function(){ proj = this.value; tick(); });

  function tick(){
    var qs = proj ? ('?project='+encodeURIComponent(proj)) : '';
    fetch('/state'+qs).then(function(r){return r.json();}).then(function(s){
      S = s;
      sess.textContent = s.sessionId
        ? 'sessão '+s.sessionId.slice(0,8)+' · '+s.agents.length+' agente(s) · '+s.timeline.length+' handoff(s)'
        : 'nenhuma sessão ativa encontrada';
      renderFlow(s.agents);
      renderTimeline(s.timeline);
      renderRoster(s.agents);
    }).catch(function(){ sess.textContent='erro ao ler estado'; });
  }
  loadProjects();
  setInterval(tick, 2000);
</script>
</body>
</html>`;
