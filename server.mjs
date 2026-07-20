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

// Versão do app: no Electron vem via AGENT_ROOM_VERSION (injetada pelo main.mjs);
// rodando solto por node, lê o package.json do desktop como referência.
const APP_VERSION = process.env.AGENT_ROOM_VERSION || readDesktopVersion() || 'dev';
function readDesktopVersion() {
  try {
    const p = path.join(HERE_EARLY(), 'desktop', 'package.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).version;
  } catch { return null; }
}
function HERE_EARLY() { return path.dirname(fileURLToPath(import.meta.url)); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPRITE_SHEET = path.join(HERE, 'assets', 'characters.png');
const TILE_SHEET = path.join(HERE, 'assets', 'tiles.png');
const TILE_SHEET2 = path.join(HERE, 'assets', 'tiles2.png');

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

// ---- Preferências do usuário (sala + avatares) ----------------------------
// Ficam SÓ no PC (produto local e instalado): ~/.claude/agent-room-prefs.json.
const PREFS_FILE = path.join(os.homedir(), '.claude', 'agent-room-prefs.json');
function readPrefs() {
  try {
    const p = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
    return {
      room: typeof p.room === 'string' ? p.room : 'escritorio',
      avatars: p.avatars && typeof p.avatars === 'object' ? p.avatars : {},
      seenChangelog: typeof p.seenChangelog === 'string' ? p.seenChangelog : '',
    };
  } catch { return { room: 'escritorio', avatars: {}, seenChangelog: '' }; }
}
function writePrefs(next) {
  const cur = readPrefs();
  const merged = {
    room: typeof next.room === 'string' ? next.room : cur.room,
    avatars: { ...cur.avatars, ...(next.avatars || {}) },
    seenChangelog: typeof next.seenChangelog === 'string' ? next.seenChangelog : cur.seenChangelog,
  };
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(merged, null, 2));
  } catch (e) { console.error('Falha ao salvar preferências:', e.message); }
  return merged;
}

// ---- Catálogo de salas (cenários) -----------------------------------------
// Cada sala tem paleta (piso/parede/tapete desenhados no canvas) + `deco`:
// móveis em pixel-art do tileset CC0 "Roguelike Indoors" (Kenney). Cada item
// de deco = { t:[col,row] no tiles.png, x,y = posição 0..1 na sala (âncora no
// pé, centro), s = escala (padrão 3), w/h = tiles de largura/altura (padrão 1) }.
// Coordenadas mapeadas manualmente da folha (grade 27×18, tiles 16px stride 17).
const ROOMS = [
  { id: 'escritorio', name: 'Escritório', emoji: '🏢',
    floor: '#2c333f', floor2: '#262c37', wall: '#3a2f26', rug: '#26466e',
    deco: [
      { t: [16, 0], x: 0.05, y: 0.99 },   // planta em vaso (canto)
      { t: [17, 0], x: 0.95, y: 0.99 },   // planta em vaso (canto)
      { t: [0, 13], x: 0.18, y: 1.0 },    // gaveteiro / credenza
      { t: [1, 13], x: 0.30, y: 1.0 },    // gaveteiro
      { t: [19, 15], x: 0.72, y: 1.0 },   // estante de livros
      { t: [20, 15], x: 0.84, y: 1.0 },   // estante de livros
      { t: [16, 4], x: 0.5, y: 1.0 },     // banqueta / mesinha
      { t: [22, 14], x: 0.5, y: 0.14, s: 2.5 }, // quadro/espelho na parede
    ] },
  { id: 'masmorra', name: 'Masmorra', emoji: '🏰',
    rug: '#3a2f1e', tileSheet: 'rpg', floorTile: [7, 2], wallTile: [6, 1],
    deco: [
      { t: [15, 8], x: 0.1, y: 1.0, sheet: 'rpg' },   // braseiro com fogo
      { t: [15, 8], x: 0.9, y: 1.0, sheet: 'rpg' },   // braseiro com fogo
      { t: [23, 0], x: 0.24, y: 1.0, sheet: 'rpg' },  // barril
      { t: [24, 0], x: 0.76, y: 1.0, sheet: 'rpg' },  // barril
      { t: [14, 0], x: 0.5, y: 1.0, sheet: 'rpg' },   // lareira acesa
    ] },
  { id: 'floresta', name: 'Floresta', emoji: '🌲',
    rug: '#255230', tileSheet: 'rpg', floorTile: [5, 0],
    deco: [
      { t: [13, 9], x: 0.07, y: 1.0, sheet: 'rpg' },  // árvore
      { t: [17, 9], x: 0.19, y: 1.0, sheet: 'rpg' },  // pinheiro
      { t: [19, 9], x: 0.34, y: 1.0, sheet: 'rpg' },  // arbusto
      { t: [15, 9], x: 0.5, y: 1.0, sheet: 'rpg' },   // árvore
      { t: [19, 9], x: 0.66, y: 1.0, sheet: 'rpg' },  // arbusto
      { t: [17, 9], x: 0.81, y: 1.0, sheet: 'rpg' },  // pinheiro
      { t: [13, 9], x: 0.93, y: 1.0, sheet: 'rpg' },  // árvore
    ] },
  { id: 'nave', name: 'Nave espacial', emoji: '🚀',
    floor: '#20293a', floor2: '#1a2231', wall: '#141a28', rug: '#1c3358',
    deco: [
      { t: [24, 8], x: 0.15, y: 1.0 },  // painel/console escuro
      { t: [22, 4], x: 0.85, y: 1.0 },  // console com tela azul
      { t: [22, 14], x: 0.5, y: 0.14, s: 2.5 }, // visor
    ] },
  { id: 'cafe', name: 'Cafeteria', emoji: '☕',
    floor: '#3a2f26', floor2: '#332a22', wall: '#241a12', rug: '#5a3a24',
    deco: [
      { t: [16, 0], x: 0.06, y: 0.99 }, { t: [17, 0], x: 0.94, y: 0.99 },
      { t: [0, 13], x: 0.2, y: 1.0 },   // balcão/gaveteiro
      { t: [16, 4], x: 0.4, y: 1.0 }, { t: [17, 4], x: 0.6, y: 1.0 }, // banquetas
      { t: [19, 15], x: 0.82, y: 1.0 }, // prateleira
    ] },
  { id: 'neon', name: 'Neon', emoji: '🌆',
    floor: '#241a33', floor2: '#1e1530', wall: '#150e26', rug: '#3a1f5e',
    deco: [
      { t: [16, 0], x: 0.06, y: 0.99 }, { t: [17, 0], x: 0.94, y: 0.99 },
      { t: [24, 8], x: 0.2, y: 1.0 },   // console
      { t: [22, 14], x: 0.5, y: 0.14, s: 2.5 },
    ] },
];

// ---- Novidades por versão (alimenta o modal "O que há de novo") ------------
// Fonte única do changelog exibido ao usuário — a mais recente aparece primeiro.
const CHANGELOG = [
  {
    version: '0.3.1',
    date: '2026-07-20',
    title: 'Floresta e Masmorra de verdade',
    items: [
      { emoji: '🌲', text: 'A Floresta agora tem chão de grama e árvores; a Masmorra ganhou piso de pedra, tochas, barris e lareira acesa.' },
      { emoji: '🖼️', text: 'Novos tiles CC0 do pack Roguelike RPG da Kenney (terreno, natureza e pedra).' },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-07-20',
    title: 'Escritório de verdade — cada agente na sua mesa',
    items: [
      { emoji: '🧑‍💻', text: 'Nova visão de sala: um escritório em grade onde cada agente senta na PRÓPRIA mesa, com computador.' },
      { emoji: '🟢', text: 'O monitor liga e anima quando o agente está trabalhando, e desliga quando ele está ocioso.' },
      { emoji: '🧑‍🤝‍🧑', text: 'Personagens novos e variados (pack Metro City) — escolha o de cada agente em ⚙︎ Personalizar.' },
      { emoji: '🎨', text: 'Arte de escritório do projeto open-source Pixel Agents (MIT); crédito no rodapé.' },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-07-20',
    title: 'Salas com cara de verdade',
    items: [
      { emoji: '🏢', text: 'As salas ganharam mobília em pixel-art: o Escritório tem mesas, estantes, plantas e quadros.' },
      { emoji: '🎨', text: 'Escolha o cenário e o avatar de cada agente em ⚙︎ Personalizar.' },
    ],
  },
  {
    version: '0.2.1',
    date: '2026-07-20',
    title: 'Deixe a sala com a sua cara',
    items: [
      { emoji: '🎨', text: 'Escolha o cenário da sala e o avatar de cada agente em ⚙︎ Personalizar.' },
      { emoji: '🔄', text: 'O app passa a se atualizar sozinho: baixa a versão nova em segundo plano e instala ao reiniciar.' },
    ],
  },
];

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
  if (url.pathname === '/version') {
    json({ version: APP_VERSION });
    return;
  }
  if (url.pathname === '/rooms') {
    json({ rooms: ROOMS });
    return;
  }
  if (url.pathname === '/changelog') {
    json({ version: APP_VERSION, entries: CHANGELOG });
    return;
  }
  if (url.pathname === '/prefs') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        let next = {};
        try { next = JSON.parse(body || '{}'); } catch {}
        json(writePrefs(next));
      });
      return;
    }
    json(readPrefs());
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
  if (req.url && req.url.startsWith('/tiles.png')) {
    try {
      const png = fs.readFileSync(TILE_SHEET);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
      res.end(png);
    } catch {
      res.writeHead(404);
      res.end('tiles ausente');
    }
    return;
  }
  if (req.url && req.url.startsWith('/tiles2.png')) {
    try {
      const png = fs.readFileSync(TILE_SHEET2);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
      res.end(png);
    } catch {
      res.writeHead(404);
      res.end('tiles2 ausente');
    }
    return;
  }
  if (url.pathname.startsWith('/pa/')) {
    // assets do escritório (pack MIT Pixel Agents) — só PNGs da pasta assets/pa
    const name = path.basename(url.pathname).replace(/[^a-zA-Z0-9_.-]/g, '');
    if (/\.png$/.test(name)) {
      try {
        const png = fs.readFileSync(path.join(HERE, 'assets', 'pa', name));
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
        res.end(png);
        return;
      } catch {}
    }
    res.writeHead(404); res.end('pa ausente'); return;
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
  /* footer / créditos */
  .foot{margin:26px 2px 8px;color:var(--muted);font-size:11.5px;display:flex;
    align-items:center;gap:8px;flex-wrap:wrap}
  .foot a{color:var(--think);text-decoration:none}
  .foot a:hover{text-decoration:underline}
  .dotsep{opacity:.5}
  /* barra de atualização */
  .updatebar{display:flex;align-items:center;gap:12px;padding:9px 20px;
    background:color-mix(in srgb,var(--work) 16%,var(--panel));
    border-bottom:1px solid color-mix(in srgb,var(--work) 40%,var(--line));font-size:13px}
  .updatebar button{background:var(--work);color:#0b0d12;border:0;border-radius:7px;
    padding:6px 12px;cursor:pointer;font-weight:640;font-size:12.5px}
  .updatebar button.x{background:transparent;color:var(--muted);margin-left:auto;padding:6px 8px}
  /* modal de personalização */
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.5);display:grid;place-items:center;z-index:50}
  .modal.hidden{display:none}  /* especificidade > .modal, senão o grid vence o none */
  .modal .sheet{background:var(--panel);border:1px solid var(--line);border-radius:16px;
    width:min(680px,94vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden}
  .sheethead{display:flex;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line)}
  .sheethead .x,.updatebar .x,.modal .x{cursor:pointer}
  .sheethead .x{margin-left:auto;background:transparent;border:0;color:var(--muted);font-size:15px}
  .sheetbody{padding:16px 18px;overflow:auto}
  .sheetbody h3{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);
    margin:6px 0 10px}
  .sheetbody h3:not(:first-child){margin-top:22px}
  .hint{color:var(--muted);font-size:12px;margin:0 0 10px}
  .roomlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
  .roomcard{border:1px solid var(--line);border-radius:11px;padding:10px;cursor:pointer;
    display:flex;flex-direction:column;gap:8px;background:var(--panel2)}
  .roomcard.on{border-color:var(--think);box-shadow:0 0 0 2px color-mix(in srgb,var(--think) 30%,transparent)}
  .roomcard .sw{height:36px;border-radius:7px;border:1px solid var(--line)}
  .roomcard .rn{font-size:12.5px;font-weight:600}
  .chips{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:12px}
  .chip{border:1px solid var(--line);border-radius:999px;padding:5px 11px;cursor:pointer;
    font-size:12.5px;background:var(--panel2);color:var(--muted);display:inline-flex;gap:6px;align-items:center}
  .chip.on{border-color:var(--accent,#6366f1);color:var(--text);
    background:color-mix(in srgb,var(--accent,#6366f1) 16%,var(--panel2))}
  .pickerwrap{border:1px solid var(--line);border-radius:11px;padding:8px;overflow:auto;background:var(--panel2)}
  #picker{display:block;image-rendering:pixelated;cursor:pointer}
  .credit{margin-top:12px;color:var(--muted);font-size:11.5px;display:flex;
    align-items:center;gap:10px;flex-wrap:wrap}
  .credit a{color:var(--think);text-decoration:none}
  .linkbtn{background:transparent;border:0;color:var(--think);cursor:pointer;font-size:11.5px;padding:0}
  /* modal "o que há de novo" */
  .sheet.nw{width:min(520px,94vw)}
  .nwtag{font-size:12px;font-weight:700;color:var(--work);
    background:color-mix(in srgb,var(--work) 16%,transparent);
    border:1px solid color-mix(in srgb,var(--work) 40%,var(--line));
    padding:3px 9px;border-radius:999px}
  .nwver{color:var(--muted);font-size:12px;margin:0 0 14px}
  .nwlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}
  .nwlist li{display:flex;gap:11px;align-items:flex-start;font-size:13.5px;line-height:1.4}
  .nwlist .ic{font-size:19px;line-height:1;flex:none;width:24px;text-align:center}
  .sheetfoot{display:flex;justify-content:flex-end;gap:10px;padding:14px 18px;
    border-top:1px solid var(--line)}
  .btnprimary{background:var(--think);color:#0b0d12;border:0;border-radius:8px;
    padding:8px 16px;cursor:pointer;font-weight:640;font-size:13px}
  .btnghost{background:transparent;color:var(--muted);border:1px solid var(--line);
    border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px}
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
  <button class="theme" id="settings" title="Personalizar sala e avatares">⚙︎ Personalizar</button>
  <button class="theme" id="theme">☀︎ / ☾</button>
</header>
<div id="updateBar" class="updatebar hidden">
  <span id="updateMsg">Nova versão disponível.</span>
  <button id="updateBtn">Atualizar agora</button>
  <button id="updateClose" class="x" title="Depois">✕</button>
</div>
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

  <footer class="foot">
    <span id="verLabel">Sala dos Agentes</span>
    <span class="dotsep">·</span>
    <span>Arte: escritório e personagens de <a href="https://github.com/pablodelucca/pixel-agents" target="_blank" rel="noreferrer">Pixel Agents</a> (MIT) — chars <em>Metro City</em> por JIK-A-4; cenários <a href="https://kenney.nl" target="_blank" rel="noreferrer">Kenney</a> (CC0)</span>
  </footer>
</main>

<div id="modal" class="modal hidden">
  <div class="sheet">
    <div class="sheethead">
      <strong>Personalizar</strong>
      <button id="modalClose" class="x">✕</button>
    </div>
    <div class="sheetbody">
      <h3>Sala</h3>
      <div id="roomList" class="roomlist"></div>

      <h3>Avatar por agente</h3>
      <p class="hint">Escolha o agente (abaixo) e clique no personagem que ele deve usar.</p>
      <div id="agentChips" class="chips"></div>
      <div class="pickerwrap">
        <canvas id="picker"></canvas>
      </div>
      <div class="credit">
        Arte CC0 — <a href="https://kenney.nl/assets/roguelike-characters" target="_blank" rel="noreferrer">Kenney · Roguelike Characters</a>.
        <button id="resetAvatar" class="linkbtn">Restaurar padrão deste agente</button>
      </div>
    </div>
  </div>
</div>

<div id="whatsnew" class="modal hidden">
  <div class="sheet nw">
    <div class="sheethead">
      <span class="nwtag">✨ Novidades</span>
      <strong id="nwTitle" style="margin-left:8px"></strong>
      <button id="nwCloseX" class="x" title="Ver depois">✕</button>
    </div>
    <div class="sheetbody">
      <div id="nwVer" class="nwver"></div>
      <ul id="nwList" class="nwlist"></ul>
    </div>
    <div class="sheetfoot">
      <button id="nwLater" class="btnghost">Ver depois</button>
      <button id="nwOk" class="btnprimary">Entendi</button>
    </div>
  </div>
</div>
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
  // folha de móveis (tileset CC0 Roguelike Indoors, Kenney) — 16px, stride 17.
  var tiles = new Image(); var tilesReady = false;
  tiles.onload = function(){ tilesReady = true; };
  tiles.src = '/tiles.png';
  // 2ª folha (tileset CC0 Roguelike/RPG pack, Kenney) — terreno, árvores, pedra.
  var tiles2 = new Image(); var tiles2Ready = false;
  tiles2.onload = function(){ tiles2Ready = true; };
  tiles2.src = '/tiles2.png';
  function sheetOf(name){ return name==='rpg' ? tiles2 : tiles; }
  function sheetReadyOf(name){ return name==='rpg' ? tiles2Ready : tilesReady; }

  // ---- assets do escritório (pack MIT "Pixel Agents", personagens Metro City)
  function paImg(file){ var i=new Image(); i.src='/pa/'+file+'.png'; return i; }
  var PA = {
    floor: paImg('floor_0'), floorGrass: null,
    wall: paImg('wall_0'),
    desk: paImg('DESK_FRONT'),
    chair: paImg('CUSHIONED_CHAIR_BACK'),
    pcOff: paImg('PC_FRONT_OFF'),
    pcOn: [paImg('PC_FRONT_ON_1'), paImg('PC_FRONT_ON_2'), paImg('PC_FRONT_ON_3')],
    plant: paImg('PLANT'), largePlant: paImg('LARGE_PLANT'),
    whiteboard: paImg('WHITEBOARD'), bookshelf: paImg('BOOKSHELF'),
    chars: [paImg('char_0'),paImg('char_1'),paImg('char_2'),paImg('char_3'),paImg('char_4'),paImg('char_5')],
  };
  // papel -> índice do personagem (0..5). O usuário pode trocar em Personalizar.
  var CHAR_BY_ROLE = { orquestrador:0, pm:2, 'pm-lead':2, 'pm-growth':2, 'pm-core':3,
    pesquisador:4, po:1, pa:5, designer:1, 'lead-design':3, qa:0, 'pos-release':4,
    'cs-implantacao':5, Explore:2, Plan:3, 'general-purpose':0, claude:4 };
  function charFor(role){
    var o = PREFS.avatars && PREFS.avatars[role];
    if(typeof o==='number' && o>=0 && o<6) return PA.chars[o];
    var idx = CHAR_BY_ROLE[role]; if(idx==null) idx = Math.abs(hashStr(role))%6;
    return PA.chars[idx];
  }
  function hashStr(s){ var h=0; s=String(s); for(var i=0;i<s.length;i++){h=(h<<5)-h+s.charCodeAt(i)|0;} return h; }

  // Preferências (sala + avatares) — carregadas de /prefs, salvas no PC.
  var PREFS = { room:'escritorio', avatars:{} };
  var ROOMS = []; var activeRoom = null;
  function resolveRoom(){
    activeRoom = null;
    for(var i=0;i<ROOMS.length;i++) if(ROOMS[i].id===PREFS.room){ activeRoom=ROOMS[i]; break; }
    if(!activeRoom) activeRoom = ROOMS[0] || null;
  }
  // Avatar de um papel: override do usuário vence; senão o mapa padrão.
  function spriteFor(type){
    var o = PREFS.avatars && PREFS.avatars[type];
    if(o && o.length===2) return o;
    return SPRITE[type] || FALLBACK;
  }

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

  // Preenche uma área repetindo um tile [col,row] de uma folha (escala TS).
  var TS = 3; // 16px -> 48px
  function tileFill(sheetName, tR, x0, y0, x1, y1){
    var img=sheetOf(sheetName); if(!sheetReadyOf(sheetName)) return false;
    var step=TILE*TS;
    for(var y=y0;y<y1;y+=step) for(var x=x0;x<x1;x+=step)
      ctx.drawImage(img, tR[0]*STRIDE, tR[1]*STRIDE, TILE, TILE, x, y, step, step);
    return true;
  }

  function drawFloor(w,h){
    var R = activeRoom || {};
    var wallH = 46;
    var sh = R.tileSheet || 'rpg';
    // ---- parede (topo) ----
    var wallDone = R.wallTile && tileFill(sh, R.wallTile, 0, 0-(TILE*TS-wallH), w, wallH);
    if(!wallDone){ ctx.fillStyle = R.wall || cssVar('--floor'); ctx.fillRect(0,0,w,wallH); }
    // rodapé/faixa entre parede e piso
    ctx.fillStyle = R.rug || cssVar('--floor2');
    ctx.fillRect(0,wallH-4,w,4);
    // ---- piso ----
    var floorDone = R.floorTile && tileFill(sh, R.floorTile, 0, wallH, w, h);
    if(!floorDone){
      ctx.fillStyle = R.floor || cssVar('--floor'); ctx.fillRect(0,wallH,w,h-wallH);
      ctx.fillStyle = R.floor2 || cssVar('--floor2');
      var s=26;
      for(var y=wallH;y<h;y+=s) for(var x=0;x<w;x+=s)
        if((Math.floor(x/s)+Math.floor(y/s))%2===0) ctx.fillRect(x,y,s,Math.min(s,h-y));
    }
    // tapete central (só quando o piso é cor chapada — sobre tile fica poluído)
    if(!floorDone){
      ctx.save(); ctx.globalAlpha=.5; ctx.fillStyle=R.rug||cssVar('--floor2');
      var rw=Math.min(w-80,520), rx=(w-rw)/2, ry=wallH+22;
      roundRect(rx,ry,rw,h-ry-22,14); ctx.fill(); ctx.restore();
    }
    // móveis em pixel-art (deco da sala) — desenhados por cima do piso
    drawDeco(w, h);
    ctx.strokeStyle = cssVar('--line'); ctx.lineWidth=1;
    ctx.globalAlpha=.5; ctx.strokeRect(.5,.5,w-1,h-1); ctx.globalAlpha=1;
  }

  // Desenha os móveis da sala a partir do tileset (âncora no pé, centro).
  function drawDeco(w,h){
    var R = activeRoom || {}; if(!R.deco) return;
    for(var i=0;i<R.deco.length;i++){
      var d=R.deco[i], sp=d.t, sc=d.s||3, tw=(d.w||1), th=(d.h||1);
      var sName=d.sheet||'indoor'; if(!sheetReadyOf(sName)) continue;
      var dw=TILE*sc*tw, dh=TILE*sc*th;
      var cx=d.x*w, feet=d.y*h;
      var dx=Math.round(cx-dw/2), dy=Math.round(feet-dh);
      // sombra leve no chão
      ctx.save(); ctx.fillStyle='rgba(0,0,0,.20)';
      ctx.beginPath(); ctx.ellipse(cx, feet-2, dw*0.4, 5, 0, 0, 7); ctx.fill(); ctx.restore();
      ctx.drawImage(sheetOf(sName), sp[0]*STRIDE, sp[1]*STRIDE, TILE*tw, TILE*th, dx, dy, dw, dh);
    }
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
    var sp = spriteFor(a.type);
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

  // ---- Escritório em grade (estilo Pixel Agents) ------------------------
  var PSC = 3, PT = 16*PSC;          // escala e tile do escritório
  var CELL_W = 4*PT, CELL_H = 4*PT;  // baia = 4x4 tiles
  var COL_GAP = 18, ROW_GAP = 34;    // respiro entre baias (evita balão colidir)

  function officeCols(w){ return Math.max(1, Math.floor((w+COL_GAP) / (CELL_W+COL_GAP))); }
  function officeSize(n, w){
    var cols = Math.min(officeCols(w), Math.max(1,n));
    var rows = Math.ceil(n / cols);
    return { cols:cols, rows:rows, h: PT + 8 + rows*CELL_H + (rows-1)*ROW_GAP + 26 };
  }

  // Preenche o piso: tile temático (rpg/indoor) se a sala definir, senão o piso PA.
  function drawOfficeFloor(w,h){
    var R = activeRoom || {}, wallH = PT;
    var sh = R.tileSheet || 'rpg';
    // parede (topo)
    if(R.wallTile && sheetReadyOf(sh)){
      var st=TILE*TS; for(var x=0;x<w;x+=st) ctx.drawImage(sheetOf(sh),R.wallTile[0]*STRIDE,R.wallTile[1]*STRIDE,TILE,TILE,x,wallH-st,st,st);
    } else if(PA.wall.complete){
      for(var x=0;x<w;x+=PT) ctx.drawImage(PA.wall,16,0,16,16,x,0,PT,PT);
    } else { ctx.fillStyle=R.wall||'#333'; ctx.fillRect(0,0,w,wallH); }
    // piso
    if(R.floorTile && sheetReadyOf(sh)){
      var st2=TILE*TS; for(var y=wallH;y<h;y+=st2) for(var x2=0;x2<w;x2+=st2) ctx.drawImage(sheetOf(sh),R.floorTile[0]*STRIDE,R.floorTile[1]*STRIDE,TILE,TILE,x2,y,st2,st2);
    } else if(PA.floor.complete){
      for(var y2=wallH;y2<h;y2+=PT) for(var x3=0;x3<w;x3+=PT) ctx.drawImage(PA.floor,0,0,16,16,x3,y2,PT,PT);
    } else { ctx.fillStyle=R.floor||'#888'; ctx.fillRect(0,wallH,w,h-wallH); }
  }

  // Desenha uma baia: cadeira + agente + mesa + PC + nome/estado/balão.
  function drawWorkstation(a, gx, gy, t){
    var wx = gx + CELL_W/2, deskBottom = gy + CELL_H - PT*0.4;
    var deskW=48*PSC, deskH=32*PSC, deskX=wx-deskW/2, deskY=deskBottom-deskH;
    var active = a.status==='working' || a.status==='thinking';
    var bob = active ? Math.round(Math.sin(t/220 + gx)*1.5) : 0;
    var aw=16*PSC, ah=32*PSC, ax=wx-aw/2, aBottom=deskY+10*PSC, ay=aBottom-ah - bob;
    // cadeira
    if(PA.chair.complete) ctx.drawImage(PA.chair, wx-8*PSC, ay+4*PSC, 16*PSC, 16*PSC);
    // agente (personagem Metro City, frame frontal parado 16x32)
    var img = charFor(a.type);
    ctx.save(); if(!active && (a.status==='idle')) ctx.globalAlpha=.6;
    if(img && img.complete) ctx.drawImage(img, 0,0,16,32, ax, ay, aw, ah);
    else { ctx.fillStyle=a.color||'#888'; ctx.fillRect(ax,ay,aw,ah); }
    ctx.restore();
    // mesa (oclui parte de baixo)
    if(PA.desk.complete) ctx.drawImage(PA.desk, deskX, deskY, deskW, deskH);
    // PC — ligado e animado quando ativo; desligado quando ocioso
    var ps=PSC*0.8, pw=16*ps, ph=32*ps, px=wx+8*PSC, py=(deskY+18*PSC)-ph;
    var pcImg = active ? PA.pcOn[Math.floor(t/220)%3] : PA.pcOff;
    if(pcImg && pcImg.complete) ctx.drawImage(pcImg, px, py, pw, ph);
    // ponto de status na cadeira/ombro
    ctx.fillStyle=statusColor(a.status);
    ctx.beginPath(); ctx.arc(ax+aw-3, ay+7, 4, 0, 7); ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,.35)'; ctx.lineWidth=1; ctx.stroke();
    // nome (abaixo da mesa)
    ctx.fillStyle=cssVar('--text'); ctx.textAlign='center'; ctx.textBaseline='top';
    ctx.font='650 12px ui-sans-serif,system-ui'; ctx.fillText(a.name, wx, deskBottom+3);
    // balão do que está fazendo
    if(active && a.doing) bubble(wx, ay+4, a.doing);
    else if(a.status==='done'){ ctx.fillStyle=cssVar('--muted'); ctx.font='11px ui-sans-serif';
      ctx.textBaseline='top'; ctx.fillText('✓ concluído', wx, deskBottom+18); }
  }

  function drawOffice(cssW, cssH, t){
    ctx.imageSmoothingEnabled=false;
    drawOfficeFloor(cssW, cssH);
    var n=S.agents.length, cols=Math.min(officeCols(cssW), Math.max(1,n));
    var gridW = cols*CELL_W + (cols-1)*COL_GAP, ox=Math.round((cssW-gridW)/2), startY=PT+8;
    for(var i=0;i<n;i++){
      var r=Math.floor(i/cols), c=i%cols;
      drawWorkstation(S.agents[i], ox+c*(CELL_W+COL_GAP), startY+r*(CELL_H+ROW_GAP), t);
    }
    if(n===0){ ctx.fillStyle=cssVar('--muted'); ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.font='13px ui-sans-serif'; ctx.fillText('nenhum agente ativo nesta sessão', cssW/2, cssH/2); }
  }

  function drawRoom(t){
    if(view==='room'){
      var wrap = canvas.parentElement;
      var cssW = Math.max(wrap.clientWidth-20, CELL_W+40);
      var sz = officeSize(S.agents.length, cssW);
      var cssH = Math.max(320, sz.h);
      var dpr = window.devicePixelRatio || 1;
      if(canvas.width!==Math.round(cssW*dpr) || canvas.height!==Math.round(cssH*dpr)){
        canvas.width=Math.round(cssW*dpr); canvas.height=Math.round(cssH*dpr);
        canvas.style.width=cssW+'px'; canvas.style.height=cssH+'px';
      }
      ctx.setTransform(dpr,0,0,dpr,0,0);
      drawOffice(cssW, cssH, t);
    }
    requestAnimationFrame(drawRoom);
  }
  requestAnimationFrame(drawRoom);
  // Exposto para verificação fora do rAF (aba sem foco estrangula o loop).
  window.__renderOffice = function(){
    var wrap=canvas.parentElement, cssW=Math.max((wrap?wrap.clientWidth:900)-20, CELL_W+40);
    var sz=officeSize(S.agents.length,cssW), cssH=Math.max(320,sz.h);
    canvas.width=cssW; canvas.height=cssH; canvas.style.width=cssW+'px'; canvas.style.height=cssH+'px';
    ctx.setTransform(1,0,0,1,0,0); drawOffice(cssW,cssH, Date.now());
    return cssW+'x'+cssH;
  };

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
  // ---- personalização: sala + avatares ---------------------------------
  var modal = document.getElementById('modal');
  var roomList = document.getElementById('roomList');
  var agentChips = document.getElementById('agentChips');
  var picker = document.getElementById('picker');
  var pctx = picker.getContext('2d');
  var selAgent = 'orquestrador'; // papel sendo editado no picker
  var PSCALE = 2; // zoom da folha no picker

  function savePrefs(){
    fetch('/prefs',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(PREFS)}).catch(function(){});
  }
  function loadPrefs(){
    return Promise.all([
      fetch('/prefs').then(function(r){return r.json();}),
      fetch('/rooms').then(function(r){return r.json();})
    ]).then(function(res){
      PREFS = res[0] || PREFS; if(!PREFS.avatars) PREFS.avatars={};
      ROOMS = (res[1] && res[1].rooms) || [];
      resolveRoom();
    }).catch(function(){});
  }

  function renderRooms(){
    roomList.innerHTML = ROOMS.map(function(r){
      var sw='linear-gradient(135deg,'+r.wall+' 0 30%,'+r.floor+' 30% 70%,'+r.rug+' 70%)';
      return '<div class="roomcard'+(r.id===PREFS.room?' on':'')+'" data-room="'+r.id+'">'+
        '<div class="sw" style="background:'+sw+'"></div>'+
        '<div class="rn">'+r.emoji+' '+r.name+'</div></div>';
    }).join('');
  }
  roomList.addEventListener('click', function(e){
    var c=e.target.closest('[data-room]'); if(!c) return;
    PREFS.room=c.getAttribute('data-room'); resolveRoom(); renderRooms(); savePrefs();
  });

  // papéis conhecidos (mesma ordem das mesas) + os que aparecerem na sessão
  var KNOWN_ROLES = ['orquestrador','pesquisador','pm','po','pa','designer',
    'lead-design','qa','pos-release','cs-implantacao','Explore','Plan',
    'general-purpose','claude'];
  function rolesForChips(){
    var set = KNOWN_ROLES.slice();
    (S.agents||[]).forEach(function(a){ if(set.indexOf(a.type)<0) set.push(a.type); });
    return set;
  }
  function renderChips(){
    agentChips.innerHTML = rolesForChips().map(function(t){
      var nm = roleName(t)===t ? t : roleName(t);
      return '<span class="chip'+(t===selAgent?' on':'')+'" data-role="'+t+'">'+
        roleEmoji(t)+' '+nm+'</span>';
    }).join('');
  }
  agentChips.addEventListener('click', function(e){
    var c=e.target.closest('[data-role]'); if(!c) return;
    selAgent=c.getAttribute('data-role'); renderChips(); drawPicker();
  });

  // Desenha a folha inteira no picker; destaca o tile atual do agente.
  // Picker de personagem: mostra os 6 personagens (frame frontal) lado a lado.
  function currentCharIdx(){
    var o = PREFS.avatars && PREFS.avatars[selAgent];
    if(typeof o==='number') return o;
    var idx = CHAR_BY_ROLE[selAgent]; return idx==null ? (Math.abs(hashStr(selAgent))%6) : idx;
  }
  function drawPicker(){
    var CS=4, cw=16*CS, chh=32*CS, gap=16, pad=8;
    var w=pad*2 + 6*cw + 5*gap, h=pad*2 + chh;
    picker.width=w; picker.height=h;
    pctx.imageSmoothingEnabled=false; pctx.clearRect(0,0,w,h);
    var cur=currentCharIdx();
    for(var i=0;i<6;i++){
      var x=pad+i*(cw+gap), im=PA.chars[i];
      if(i===cur){ pctx.fillStyle='rgba(245,158,11,.18)'; pctx.fillRect(x-4,pad-4,cw+8,chh+8); }
      if(im && im.complete) pctx.drawImage(im, 0,0,16,32, x, pad, cw, chh);
      if(i===cur){ pctx.strokeStyle='#f59e0b'; pctx.lineWidth=2; pctx.strokeRect(x-4+1,pad-4+1,cw+8-2,chh+8-2); }
    }
    picker.dataset.layout = JSON.stringify({pad:pad,cw:cw,gap:gap});
  }
  function retryPickerIfNeeded(){ if(!PA.chars[0].complete){ setTimeout(function(){ drawPicker(); },150); } }
  picker.addEventListener('click', function(e){
    var CS=4, cw=16*CS, gap=16, pad=8;
    var rect=picker.getBoundingClientRect();
    var scale=picker.width/rect.width;              // canvas px por css px
    var cx=(e.clientX-rect.left)*scale;
    var i=Math.floor((cx-pad)/(cw+gap));
    if(i>=0 && i<6){ PREFS.avatars[selAgent]=i; savePrefs(); drawPicker(); }
  });
  document.getElementById('resetAvatar').addEventListener('click', function(){
    delete PREFS.avatars[selAgent]; savePrefs(); drawPicker();
  });

  function openModal(){ renderRooms(); renderChips(); drawPicker(); retryPickerIfNeeded();
    modal.classList.remove('hidden'); }
  function closeModal(){ modal.classList.add('hidden'); }
  document.getElementById('settings').onclick=openModal;
  document.getElementById('modalClose').onclick=closeModal;
  modal.addEventListener('click', function(e){ if(e.target===modal) closeModal(); });

  // ---- atualização (electron-updater via preload) -----------------------
  var bar=document.getElementById('updateBar'), uMsg=document.getElementById('updateMsg'),
      uBtn=document.getElementById('updateBtn');
  document.getElementById('updateClose').onclick=function(){ bar.classList.add('hidden'); };
  if(window.agentRoom && window.agentRoom.onUpdate){
    window.agentRoom.onUpdate(function(ev){
      if(ev.status==='available'){
        uMsg.textContent='Nova versão '+(ev.version||'')+' disponível — baixando…';
        uBtn.style.display='none'; bar.classList.remove('hidden');
      } else if(ev.status==='downloaded'){
        uMsg.textContent='Versão '+(ev.version||'')+' pronta para instalar.';
        uBtn.style.display=''; uBtn.textContent='Reiniciar e atualizar';
        bar.classList.remove('hidden');
      }
    });
    uBtn.onclick=function(){ if(window.agentRoom.installUpdate) window.agentRoom.installUpdate(); };
  }
  fetch('/version').then(function(r){return r.json();}).then(function(v){
    var vv = (window.agentRoom && window.agentRoom.version) || v.version;
    document.getElementById('verLabel').textContent='Sala dos Agentes v'+vv;
  }).catch(function(){});

  // ---- modal "o que há de novo" -----------------------------------------
  var nw = document.getElementById('whatsnew');
  var nwCurrent = ''; // versão exibida no modal
  function closeWhatsNew(){ nw.classList.add('hidden'); }
  function ackWhatsNew(){
    PREFS.seenChangelog = nwCurrent; savePrefs(); closeWhatsNew();
  }
  document.getElementById('nwOk').onclick = ackWhatsNew;
  document.getElementById('nwLater').onclick = closeWhatsNew;
  document.getElementById('nwCloseX').onclick = closeWhatsNew;
  nw.addEventListener('click', function(e){ if(e.target===nw) closeWhatsNew(); });

  function maybeWhatsNew(){
    fetch('/changelog').then(function(r){return r.json();}).then(function(d){
      var entries = d.entries || []; if(!entries.length) return;
      var latest = entries[0];
      // 'dev' (rodando por node, sem app) não incomoda; só mostra no app instalado.
      if(d.version==='dev') return;
      if(PREFS.seenChangelog === latest.version) return; // já confirmou esta versão
      nwCurrent = latest.version;
      document.getElementById('nwTitle').textContent = latest.title || 'O que há de novo';
      document.getElementById('nwVer').textContent =
        'Versão '+latest.version + (latest.date ? ' · '+latest.date : '');
      document.getElementById('nwList').innerHTML = (latest.items||[]).map(function(it){
        return '<li><span class="ic">'+(it.emoji||'•')+'</span><span>'+it.text+'</span></li>';
      }).join('');
      nw.classList.remove('hidden');
    }).catch(function(){});
  }

  loadPrefs().then(function(){ loadProjects(); maybeWhatsNew(); });
  setInterval(tick, 2000);
</script>
</body>
</html>`;
