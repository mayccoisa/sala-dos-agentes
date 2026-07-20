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
      status: p.status && typeof p.status === 'object' ? p.status : {},
    };
  } catch { return { room: 'escritorio', avatars: {}, seenChangelog: '', status: {} }; }
}
function writePrefs(next) {
  const cur = readPrefs();
  const merged = {
    room: typeof next.room === 'string' ? next.room : cur.room,
    avatars: { ...cur.avatars, ...(next.avatars || {}) },
    seenChangelog: typeof next.seenChangelog === 'string' ? next.seenChangelog : cur.seenChangelog,
    // status é SUBSTITUÍDO (o cliente envia o mapa completo) — permite remover chaves.
    status: next.status && typeof next.status === 'object' ? next.status : cur.status,
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
    version: '0.9.0',
    date: '2026-07-20',
    title: 'Status manual — mande o agente almoçar, focar ou ir pra casa',
    items: [
      { emoji: '🖱️', text: 'Clique num agente (no mapa ou na lista) para abrir o menu de status.' },
      { emoji: '🍽️', text: 'Almoço leva o agente para a cantina; Reunião leva pra sala de reunião; Casa tira ele da mesa.' },
      { emoji: '🎯', text: 'Foco mantém na mesa em modo concentrado. "Automático" volta a seguir o que o chat está fazendo.' },
      { emoji: '💾', text: 'A escolha fica salva no seu PC. (Sincronizar com o Slack vem numa próxima versão.)' },
    ],
  },
  {
    version: '0.8.0',
    date: '2026-07-20',
    title: 'Cara de empresa — lobby, salas de reunião, cantina e descanso',
    items: [
      { emoji: '🏢', text: 'Lobby com logo da empresa e relógio no topo do mapa.' },
      { emoji: '💬', text: 'Duas salas de reunião: quando um agente está pensando, ele sai da mesa e vai reunir.' },
      { emoji: '🍽️', text: 'Cantina e sala de descanso com 2 PCs gamer.' },
      { emoji: '✨', text: 'Agente trabalhando agora tem um brilho pulsante bem visível (a bolinha antiga sumia).' },
      { emoji: '🪧', text: 'Plaquinha em cada mesa com o nome do agente e o cargo.' },
      { emoji: '🧰', text: 'Ferramenta na mesa de acordo com o papel (prancheta pro Designer, livros pro Pesquisador, etc.).' },
      { emoji: '👔', text: 'O Orquestrador virou o "Boss".' },
    ],
  },
  {
    version: '0.7.0',
    date: '2026-07-20',
    title: 'Lista ao lado do mapa e linha do tempo de todos os chats',
    items: [
      { emoji: '📋', text: 'A lista de agentes saiu de baixo e agora fica ao LADO do mapa, agrupada pelas mesmas áreas — dá pra ver tudo de uma vez.' },
      { emoji: '🕒', text: 'A linha do tempo ganhou o modo "Todos os chats abertos": antes ela mostrava só o chat atual, agora dá pra ver os handoffs de todas as sessões ativas.' },
      { emoji: '🏷️', text: 'No modo "todos", cada handoff mostra de qual chat veio.' },
    ],
  },
  {
    version: '0.6.0',
    date: '2026-07-20',
    title: 'Escritório por áreas — Diretoria, Pesquisa, Dados e Chamados',
    items: [
      { emoji: '🏢', text: 'O mapa virou um escritório dividido em áreas: Diretoria, Pesquisa, Dados e Chamados — cada agente na sua área.' },
      { emoji: '🎨', text: 'Cada área tem cor, piso e móveis próprios (plantas, estante, quadro), com letreiro e contador de quantos agentes estão ativos.' },
      { emoji: '💡', text: 'A área acende quando algum agente dela está trabalhando; o balão mostra o que ele está fazendo.' },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-07-20',
    title: 'O mapa do time — cada agente na sua salinha',
    items: [
      { emoji: '🗺️', text: 'A tela principal virou um mapa do escritório: TODOS os agentes do time aparecem, cada um na sua própria salinha.' },
      { emoji: '💡', text: 'A salinha acende (borda colorida + monitor ligado + balão) quando aquele agente está trabalhando; fica apagada quando está inativo.' },
      { emoji: '🏷️', text: 'Cada sala tem letreiro com o nome do papel (Orquestrador, PM, PO, Designer, QA, Conformidade ISO…).' },
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
  orquestrador: { emoji: '🧠', name: 'Boss', color: '#6366f1' },
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

// ---- Linha do tempo de TODOS os chats abertos -----------------------------
// "Aberto" = .jsonl com atividade recente. Cada sessão vira um buildState;
// como os .jsonl podem ter MBs, o resultado é cacheado pela assinatura de mtime
// (arquivo principal + subagentes), então o polling de 2s fica barato.
const OPEN_WINDOW_MS = 60 * 60 * 1000; // 1h sem atividade => chat fechado
const MAX_OPEN_SESSIONS = 8;
const stateCache = new Map();

function sessionSig(dir, sid) {
  let sig = '';
  try { sig = String(fs.statSync(path.join(dir, `${sid}.jsonl`)).mtimeMs); } catch {}
  sig += '|' + newestJsonlMtime(path.join(dir, sid, 'subagents'));
  return sig;
}
function buildStateCached(dir, sid) {
  const key = dir + '::' + sid;
  const sig = sessionSig(dir, sid);
  const hit = stateCache.get(key);
  if (hit && hit.sig === sig) return hit.state;
  const state = buildState(dir, sid);
  stateCache.set(key, { sig, state });
  if (stateCache.size > 24) stateCache.delete(stateCache.keys().next().value);
  return state;
}
function openSessions(dir) {
  const out = [];
  const now = Date.now();
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const st = fs.statSync(path.join(dir, f));
      if (now - st.mtimeMs <= OPEN_WINDOW_MS)
        out.push({ id: f.replace(/\.jsonl$/, ''), mtime: st.mtimeMs });
    }
  } catch {}
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, MAX_OPEN_SESSIONS);
}
function timelineAll(dir) {
  const sessions = openSessions(dir);
  const merged = [];
  const info = [];
  for (const s of sessions) {
    const st = buildStateCached(dir, s.id);
    info.push({ id: s.id, mtime: s.mtime, agents: (st.agents || []).length,
      handoffs: (st.timeline || []).length });
    for (const e of st.timeline || []) merged.push({ ...e, session: s.id });
  }
  merged.sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));
  return { sessions: info, timeline: merged.slice(-80) };
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
  if (url.pathname === '/timeline-all') {
    const projParam = url.searchParams.get('project');
    const dir = projParam ? path.join(PROJECTS_ROOT, projParam) : PROJECT_DIR;
    json(timelineAll(dir));
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
  main{padding:20px;max-width:1400px;margin:0 auto}
  /* mapa à esquerda + lista de agentes à direita */
  .cols{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:18px;align-items:start}
  .colmain{min-width:0}
  .colside{min-width:0;position:sticky;top:14px}
  .gridside{grid-template-columns:1fr;gap:8px;max-height:calc(100vh - 120px);overflow:auto;padding-right:2px}
  .gridside .card{padding:9px 10px}
  .gridside .card .ava{width:32px;height:32px;font-size:16px}
  .gridside .card .dc{max-width:170px}
  @media(max-width:980px){ .cols{grid-template-columns:1fr} .colside{position:static}
    .gridside{grid-template-columns:repeat(auto-fill,minmax(220px,1fr));max-height:none} }
  .tlhead{display:flex;align-items:center;gap:12px;margin:22px 2px 10px;flex-wrap:wrap}
  .seg.small button{padding:4px 10px;font-size:12px}
  .tl .sess{font-size:10.5px;color:var(--muted);border:1px solid var(--line);
    border-radius:999px;padding:1px 7px;flex:none;font-variant-numeric:tabular-nums}
  .zhead{display:flex;align-items:center;justify-content:space-between;gap:8px;
    font-size:11px;font-weight:800;letter-spacing:.3px;color:var(--zc);
    padding:8px 4px 3px;text-transform:uppercase}
  .zhead .zcount{color:var(--muted);font-weight:600;font-variant-numeric:tabular-nums}
  .gridside .card .r{gap:8px}
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
  .updatebar.hidden{display:none}  /* idem: senão a barra fica sempre visível */
  /* menu de status ao clicar num agente */
  #room{cursor:pointer}
  .statusmenu{position:absolute;z-index:60;background:var(--panel);border:1px solid var(--line);
    border-radius:11px;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:6px;min-width:170px}
  .statusmenu.hidden{display:none}
  .statusmenu .hd{font-size:11px;color:var(--muted);padding:4px 8px 6px;font-weight:700}
  .statusmenu button{display:flex;align-items:center;gap:9px;width:100%;background:transparent;
    border:0;color:var(--text);padding:7px 8px;border-radius:7px;cursor:pointer;font-size:13px;text-align:left}
  .statusmenu button:hover{background:var(--panel2)}
  .statusmenu button.on{background:color-mix(in srgb,var(--accent,#6366f1) 20%,var(--panel2))}
  .statusmenu button .k{font-size:15px;width:20px;text-align:center}
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
  <div class="cols">
    <div class="colmain">
      <div id="viewRoom">
        <h2 class="sec">Sala — a equipe trabalhando</h2>
        <div class="roomwrap"><canvas id="room" width="900" height="360"></canvas></div>
      </div>
      <div id="viewDiagram" class="hidden">
        <h2 class="sec">Fluxo — quem chamou quem</h2>
        <div class="flowwrap"><div class="stage" id="stage"></div></div>
      </div>
    </div>
    <aside class="colside">
      <h2 class="sec">Agentes</h2>
      <div class="grid gridside" id="grid"></div>
    </aside>
  </div>

  <div class="tlhead">
    <h2 class="sec" style="margin:0">Linha do tempo dos handoffs</h2>
    <div class="seg small" id="tlseg">
      <button data-scope="one" class="active">Este chat</button>
      <button data-scope="all">Todos os chats abertos</button>
    </div>
  </div>
  <div class="tl" id="timeline"></div>

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
    // áreas comuns: reunião, cantina, descanso e lobby
    tableBig: paImg('TABLE_FRONT'), smallTable: paImg('SMALL_TABLE_FRONT'),
    coffee: paImg('COFFEE'), coffeeTable: paImg('COFFEE_TABLE'),
    sofa: paImg('SOFA_FRONT'), bench: paImg('CUSHIONED_BENCH'),
    chairW: paImg('WOODEN_CHAIR_FRONT'), painting: paImg('LARGE_PAINTING'),
    clock: paImg('CLOCK'), cactus: paImg('CACTUS'), bin: paImg('BIN'),
    logo: paImg('logo'), // opcional: se assets/pa/logo.png existir, vira a logo do lobby
    chars: [paImg('char_0'),paImg('char_1'),paImg('char_2'),paImg('char_3'),paImg('char_4'),paImg('char_5')],
  };
  // papel -> índice do personagem (0..5). O usuário pode trocar em Personalizar.
  var CHAR_BY_ROLE = { orquestrador:0, pm:2, 'pm-lead':2, 'pm-growth':4, 'pm-core':3,
    pesquisador:4, po:1, pa:5, designer:1, 'lead-design':3, qa:0, 'pos-release':4,
    'cs-implantacao':5, 'conformidade-iso':2, Explore:2, Plan:3, 'general-purpose':0, claude:4 };

  // Elenco fixo do mapa: cada papel tem a sua salinha, sempre presente.
  // A cor é usada no letreiro/realce quando o agente está ativo.
  // name = cargo (mostrado no letreiro da área); person = nome do agente (na mesa).
  var ROSTER = [
    { type:'orquestrador', name:'Boss', person:'Max', color:'#6366f1' },
    { type:'pm-lead', name:'PM Lead', person:'Bia', color:'#2563eb' },
    { type:'pm-growth', name:'PM Growth', person:'Theo', color:'#0891b2' },
    { type:'pm-core', name:'PM Core', person:'Nina', color:'#0ea5e9' },
    { type:'pesquisador', name:'Pesquisador', person:'Rui', color:'#14b8a6' },
    { type:'po', name:'PO', person:'Duda', color:'#7c3aed' },
    { type:'designer', name:'Designer', person:'Cauê', color:'#db2777' },
    { type:'lead-design', name:'Lead Design', person:'Íris', color:'#c026d3' },
    { type:'pa', name:'Analista de Dados', person:'Leo', color:'#059669' },
    { type:'qa', name:'QA', person:'Sofia', color:'#16a34a' },
    { type:'pos-release', name:'Pós-Release', person:'Val', color:'#ea580c' },
    { type:'cs-implantacao', name:'CS / Implantação', person:'Rafa', color:'#d97706' },
    { type:'conformidade-iso', name:'Conformidade ISO', person:'Ono', color:'#64748b' },
  ];
  // Estado (do log da sessão) para um papel: agrega os agentes ativos daquele tipo.
  function stateForRole(type){
    var best=null;
    for(var i=0;i<S.agents.length;i++){ var a=S.agents[i]; if(a.type!==type) continue;
      var rank={working:3,thinking:3,done:2,idle:1};
      if(!best || (rank[a.status]||0)>(rank[best.status]||0)) best=a;
    }
    if(best) return { status:best.status, doing:best.doing, present:true };
    return { status:'off', doing:'', present:false }; // sem agente desse tipo na sessão
  }
  // Estado EFETIVO: um status manual (almoço/casa/reunião/foco) vence o do log.
  var MANUAL_STATUS = ['auto','foco','reuniao','almoco','casa'];
  function effState(type){
    var ov = PREFS.status && PREFS.status[type];
    if(ov && ov!=='auto' && MANUAL_STATUS.indexOf(ov)>=0)
      return { status:ov, doing:'', manual:true };
    return stateForRole(type);
  }
  function setStatus(type, val){
    if(!PREFS.status) PREFS.status={};
    if(val==='auto') delete PREFS.status[type]; else PREFS.status[type]=val;
    savePrefs();
  }
  function charFor(role){
    var o = PREFS.avatars && PREFS.avatars[role];
    if(typeof o==='number' && o>=0 && o<6) return PA.chars[o];
    var idx = CHAR_BY_ROLE[role]; if(idx==null) idx = Math.abs(hashStr(role))%6;
    return PA.chars[idx];
  }
  function hashStr(s){ var h=0; s=String(s); for(var i=0;i<s.length;i++){h=(h<<5)-h+s.charCodeAt(i)|0;} return h; }

  // Ferramenta na mesa por papel — algo ligado ao que o agente faz, em vez do PC.
  // {kind:'pc'} usa o computador (ligado/animado quando trabalhando);
  // {kind:'img', img, sw, sh} desenha uma imagem estática (proporção sw x sh).
  function deskTool(type){
    switch(type){
      case 'designer':     return { kind:'img', img:PA.whiteboard, sw:32, sh:32 }; // prancheta
      case 'lead-design':  return { kind:'img', img:PA.painting,   sw:32, sh:32 }; // arte/curadoria
      case 'pesquisador':  return { kind:'img', img:PA.bookshelf,  sw:32, sh:16 }; // livros/pesquisa
      case 'conformidade-iso': return { kind:'img', img:PA.clock,  sw:16, sh:32 }; // relógio/registro
      case 'cs-implantacao':   return { kind:'img', img:PA.coffee, sw:16, sh:16 }; // café com o cliente
      default:             return { kind:'pc' }; // Boss, PMs, PO, PA(dados), QA, Pós = computador
    }
  }

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

  // ---- Mapa principal: escritório dividido em áreas (estilo Habbo) ------
  var PSC = 3, PT = 16*PSC;   // escala e tile
  var GAP = 16;               // corredor entre áreas
  var ZHEAD = 28;             // altura do letreiro da área
  var ZPAD = 14;              // respiro interno da área
  var MZ = 2.3;               // escala das estações dentro da área
  var MS_W = 138, MS_H = 152; // célula de estação (compacta) — cabe a plaquinha
  var LOBBY_H = 74;           // faixa do lobby (logo da empresa)
  var COMMON_H = 212;         // altura das áreas comuns (reunião/cantina/descanso)

  // Áreas do escritório e quais papéis moram em cada uma.
  var ZONES = [
    { id:'diretoria', name:'Diretoria', emoji:'🏛️', color:'#6366f1',
      roles:['orquestrador','pm-lead','pm-growth','pm-core'] },
    { id:'pesquisa', name:'Pesquisa', emoji:'🔬', color:'#0891b2',
      roles:['pesquisador','designer','lead-design'] },
    { id:'dados', name:'Dados', emoji:'📊', color:'#059669',
      roles:['pa','pos-release'] },
    { id:'chamados', name:'Chamados', emoji:'🎫', color:'#ea580c',
      roles:['po','qa','cs-implantacao','conformidade-iso'] },
  ];
  function rosterMeta(type){
    for(var i=0;i<ROSTER.length;i++) if(ROSTER[i].type===type) return ROSTER[i];
    return { type:type, name:type, color:'#64748b' };
  }

  // Áreas comuns da empresa (sem elenco fixo). As salas de reunião recebem os
  // agentes que estão PENSANDO (thinking) — eles "saem" da mesa e vão reunir.
  var COMMON = [
    { id:'meet1', name:'Reunião 1', emoji:'💬', color:'#8b5cf6', kind:'meeting' },
    { id:'meet2', name:'Reunião 2', emoji:'💬', color:'#a855f7', kind:'meeting' },
    { id:'cantina', name:'Cantina', emoji:'🍽️', color:'#f59e0b', kind:'cantina' },
    { id:'descanso', name:'Descanso', emoji:'🎮', color:'#ec4899', kind:'lounge' },
  ];
  // Quem vai para a reunião (pensando OU marcado "reunião") e quem vai à cantina.
  function meetingTypes(){
    var out=[]; ROSTER.forEach(function(r){ var s=effState(r.type).status;
      if(s==='thinking'||s==='reuniao') out.push(r.type); }); return out;
  }
  function cantinaTypes(){
    var out=[]; ROSTER.forEach(function(r){ if(effState(r.type).status==='almoco') out.push(r.type); });
    return out;
  }

  // Layout (masonry) das áreas para uma largura; usado no dimensionamento e no render.
  function computeLayout(w){
    var cols = w>=820 ? 2 : 1;
    var zw = Math.floor((w - (cols+1)*GAP) / cols);
    var deskCols = Math.max(1, Math.floor((zw - 2*ZPAD) / MS_W));
    function argmin(a){ var c=0; for(var k=1;k<a.length;k++) if(a[k]<a[c]) c=k; return c; }
    // lobby ocupa o topo, largura cheia
    var lobby = { x:GAP, y:GAP, w:w-2*GAP, h:LOBBY_H };
    var top = GAP + LOBBY_H + GAP;
    // áreas de trabalho (masonry)
    var colY=[]; for(var i=0;i<cols;i++) colY[i]=top;
    var zones=[];
    ZONES.forEach(function(z){
      var rows=Math.ceil(z.roles.length/deskCols);
      var zh = ZHEAD + ZPAD + 16 + rows*MS_H + ZPAD;
      var c=argmin(colY);
      zones.push({ z:z, x:GAP+c*(zw+GAP), y:colY[c], w:zw, h:zh, deskCols:deskCols });
      colY[c]+=zh+GAP;
    });
    var zonesBottom=0; for(var j=0;j<cols;j++) zonesBottom=Math.max(zonesBottom,colY[j]);
    // divisória + áreas comuns (masonry)
    var labelY = zonesBottom + 4;
    var cStart = zonesBottom + 24;
    var ccolY=[]; for(var m=0;m<cols;m++) ccolY[m]=cStart;
    var commons=[];
    COMMON.forEach(function(cm){
      var c2=argmin(ccolY);
      commons.push({ cm:cm, x:GAP+c2*(zw+GAP), y:ccolY[c2], w:zw, h:COMMON_H });
      ccolY[c2]+=COMMON_H+GAP;
    });
    var H=0; for(var n2=0;n2<cols;n2++) H=Math.max(H,ccolY[n2]);
    return { lobby:lobby, zones:zones, commons:commons, labelY:labelY, deskCols:deskCols, height:H+4 };
  }
  function officeSize(w){ return { h: computeLayout(w).height }; }

  // Piso do prédio (corredores) — piso PA cinza ou tema da sala escolhida.
  function drawBuildingFloor(w,h){
    var R=activeRoom||{}, sh=R.tileSheet||'rpg';
    if(R.floorTile && sheetReadyOf(sh)){
      var st=TILE*TS; for(var y=0;y<h;y+=st) for(var x=0;x<w;x+=st)
        ctx.drawImage(sheetOf(sh),R.floorTile[0]*STRIDE,R.floorTile[1]*STRIDE,TILE,TILE,x,y,st,st);
    } else if(PA.floor.complete){
      for(var y2=0;y2<h;y2+=PT) for(var x2=0;x2<w;x2+=PT) ctx.drawImage(PA.floor,0,0,16,16,x2,y2,PT,PT);
    } else { ctx.fillStyle='#6b7280'; ctx.fillRect(0,0,w,h); }
    ctx.fillStyle='rgba(0,0,0,.12)'; ctx.fillRect(0,0,w,h);
  }

  // Preenche o piso interno de uma salinha com o tile PA (recortado ao retângulo).
  function fillRoomFloor(x,y,w,h){
    ctx.save(); roundRect(x,y,w,h,7); ctx.clip();
    if(PA.floor.complete){ for(var yy=y;yy<y+h;yy+=PT) for(var xx=x;xx<x+w;xx+=PT)
      ctx.drawImage(PA.floor,0,0,16,16,xx,yy,PT,PT); }
    else { ctx.fillStyle='#8a929e'; ctx.fillRect(x,y,w,h); }
    ctx.restore();
  }

  // Plaquinha de mesa: NOME do agente (destaque) + CARGO (cor do papel).
  function nameplate(cx, topY, person, cargo, color, dim){
    ctx.font='800 12.5px ui-sans-serif,system-ui';
    var w1=ctx.measureText(person).width;
    ctx.font='700 10px ui-sans-serif,system-ui';
    var w2=ctx.measureText(cargo.toUpperCase()).width;
    var bw=Math.max(w1,w2)+16, bh=30, bx=cx-bw/2, by=topY;
    ctx.save(); ctx.globalAlpha=dim?0.72:1;
    roundRect(bx,by,bw,bh,7);
    ctx.fillStyle='rgba(10,13,18,.82)'; ctx.fill();
    ctx.lineWidth=1.5; ctx.strokeStyle=color; ctx.stroke();
    ctx.textAlign='center';
    ctx.textBaseline='alphabetic'; ctx.fillStyle='#f2f5fa';
    ctx.font='800 12.5px ui-sans-serif,system-ui'; ctx.fillText(person, cx, by+13);
    ctx.fillStyle=color; ctx.font='800 9.5px ui-sans-serif,system-ui';
    ctx.fillText(cargo.toUpperCase(), cx, by+25);
    ctx.restore();
  }

  // Estação compacta (um agente) dentro de uma área.
  function drawMiniStation(type, cx, deskBottom, t){
    var st=effState(type), meta=rosterMeta(type);
    var away = st.status==='thinking' || st.status==='reuniao' || st.status==='almoco' || st.status==='casa';
    var thinking = st.status==='thinking' || st.status==='reuniao';
    var working = st.status==='working';
    var foco = st.status==='foco';
    var off=st.status==='off';
    var deskW=48*MZ, deskH=32*MZ, deskX=cx-deskW/2, deskY=deskBottom-deskH;
    var bob = working ? Math.round(Math.sin(t/220+cx)*1.4) : 0;
    var aw=16*MZ, ah=32*MZ, ax=cx-aw/2, ay=(deskY+8*MZ)-ah-bob;
    var pulse = 0.5+0.5*Math.sin(t/300+cx);
    // área clicável (para o menu de status) — mesa + personagem + plaquinha
    HITS.push({ type:type, x:cx-MS_W/2+8, y:ay-6, w:MS_W-16, h:(deskBottom+34)-(ay-6) });

    // (1) FEEDBACK de trabalhando: halo pulsante no chão + brilho atrás do agente
    if(working){
      var wc=meta.color;
      ctx.save();
      // halo no piso
      ctx.globalAlpha=0.25+0.20*pulse; ctx.fillStyle=wc;
      ctx.beginPath(); ctx.ellipse(cx, deskY+6*MZ, 26+6*pulse, 9+2*pulse, 0,0,7); ctx.fill();
      // brilho radial atrás do personagem
      var gr=ctx.createRadialGradient(cx, ay+ah*0.45, 4, cx, ay+ah*0.45, ah*0.9);
      gr.addColorStop(0, wc); gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha=0.30+0.18*pulse; ctx.fillStyle=gr;
      ctx.fillRect(cx-ah, ay-6, ah*2, ah+12);
      ctx.restore();
    }

    if(PA.chair.complete) ctx.drawImage(PA.chair, cx-8*MZ, ay+4*MZ, 16*MZ, 16*MZ);
    // Agente ausente (reunião/almoço/casa): cadeira vazia.
    if(!away){
      var img=charFor(type);
      ctx.save(); ctx.globalAlpha = off?0.5 : (st.status==='idle'?0.75:1);
      if(img && img.complete) ctx.drawImage(img,0,0,16,32, ax,ay,aw,ah);
      else { ctx.fillStyle=meta.color; ctx.fillRect(ax,ay,aw,ah); }
      ctx.restore();
    }
    if(PA.desk.complete) ctx.drawImage(PA.desk, deskX, deskY, deskW, deskH);

    // (3) FERRAMENTA na mesa (por papel), em vez do PC do lado.
    var tool=deskTool(type);
    if(tool.kind==='pc'){
      var pcImg = (working||foco) ? PA.pcOn[Math.floor(t/160)%3] : PA.pcOff;
      var ph=30*MZ*0.55, pw=16*MZ*0.85, px=cx-pw/2, py=(deskY+6*MZ)-ph*0.55;
      if(pcImg && pcImg.complete) ctx.drawImage(pcImg, px, py, pw, ph);
    } else if(tool.img && tool.img.complete){
      var scale=(deskW*0.5)/tool.sw, iw=tool.sw*scale, ih=tool.sh*scale;
      var ix=cx-iw/2, iy=(deskY+7*MZ)-ih;
      ctx.drawImage(tool.img, 0,0,tool.sw,tool.sh, ix, iy - (working?Math.round(1+pulse):0), iw, ih);
    }

    // (1) indicador de status maior e com brilho
    var scol=statusColor(off?'idle':(working||foco?'working':(thinking?'thinking':'idle')));
    ctx.save();
    if(working||thinking||foco){ ctx.shadowColor=scol; ctx.shadowBlur=8; }
    ctx.fillStyle=scol; ctx.beginPath(); ctx.arc(ax+aw-2, ay+6, working?5.5:4.5, 0, 7); ctx.fill();
    ctx.shadowBlur=0; ctx.strokeStyle='#0b0d12'; ctx.lineWidth=1.5; ctx.stroke();
    ctx.restore();

    // (2) plaquinha nome + cargo
    nameplate(cx, deskBottom+3, meta.person, meta.name, meta.color, off||away);

    // rótulo de estado (abaixo da plaquinha)
    var lbl='', lc=cssVar('--muted');
    if(working && st.doing){ bubble(cx, ay+2, st.doing); }
    else if(foco){ lbl='🎯 foco'; lc=cssVar('--work'); }
    else if(st.status==='reuniao'){ lbl='💬 reunião'; lc=cssVar('--think'); }
    else if(st.status==='thinking'){ lbl='💭 em reunião'; lc=cssVar('--think'); }
    else if(st.status==='almoco'){ lbl='🍽️ almoço'; lc='#f59e0b'; }
    else if(st.status==='casa'){ lbl='🏠 em casa'; lc='#94a3b8'; }
    else if(st.status==='done'){ lbl='✓ concluído'; }
    if(lbl){ ctx.fillStyle=lc; ctx.textAlign='center'; ctx.textBaseline='top';
      ctx.font='700 10.5px ui-sans-serif'; ctx.fillText(lbl, cx, deskBottom+36); }
  }

  // Uma área do escritório: piso próprio + letreiro + paredes + os agentes dela.
  function drawZone(item, t){
    var z=item.z, x=item.x, y=item.y, w=item.w, h=item.h;
    var bodyY=y+ZHEAD, bodyH=h-ZHEAD;
    var anyActive=false, actives=0;
    z.roles.forEach(function(r){ var s=effState(r).status;
      if(s==='working'||s==='thinking'||s==='foco'){anyActive=true;actives++;} });
    // piso da área (cinza PA) + tinta da cor da área
    fillRoomFloor(x, bodyY, w, bodyH);
    ctx.save(); roundRect(x,bodyY,w,bodyH,8); ctx.clip();
    ctx.fillStyle=z.color; ctx.globalAlpha=0.12; ctx.fillRect(x,bodyY,w,bodyH);
    // tapete central
    ctx.globalAlpha=0.16; roundRect(x+18,bodyY+14,w-36,bodyH-28,10); ctx.fill();
    ctx.restore();
    // decoração de canto (planta)
    if(PA.plant.complete) ctx.drawImage(PA.plant, x+w-16*2-8, y+h-32*2-6, 16*2, 32*2);
    if(z.id==='pesquisa' && PA.bookshelf.complete) ctx.drawImage(PA.bookshelf, x+10, bodyY+8, 32*2, 16*2);
    if(z.id==='diretoria' && PA.whiteboard.complete) ctx.drawImage(PA.whiteboard, x+10, bodyY+8, 32*1.6, 32*1.6);
    // paredes + porta
    ctx.save(); ctx.lineWidth=anyActive?3:2;
    ctx.strokeStyle = anyActive ? z.color : 'rgba(120,130,145,.7)';
    if(anyActive){ ctx.shadowColor=z.color; ctx.shadowBlur=12; }
    var doorW=2*PT, dl=x+w/2-doorW/2, dr=x+w/2+doorW/2;
    ctx.beginPath();
    ctx.moveTo(dl,y+h); ctx.lineTo(x+8,y+h); ctx.arcTo(x,y+h,x,y+h-8,8);
    ctx.lineTo(x,bodyY); ctx.lineTo(x+w,bodyY); ctx.lineTo(x+w,y+h-8);
    ctx.arcTo(x+w,y+h,x+w-8,y+h,8); ctx.lineTo(dr,y+h);
    ctx.stroke(); ctx.restore();
    ctx.fillStyle='rgba(0,0,0,.18)'; ctx.fillRect(dl,y+h-4,doorW,6);
    // letreiro
    ctx.save(); roundRect(x,y,w,ZHEAD,8); ctx.clip();
    ctx.fillStyle=z.color; ctx.globalAlpha=anyActive?1:0.85; ctx.fillRect(x,y,w,ZHEAD);
    ctx.restore();
    ctx.fillStyle='#0b0d12'; ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.font='800 13px ui-sans-serif,system-ui';
    ctx.fillText(z.emoji+'  '+z.name, x+12, y+ZHEAD/2+1);
    ctx.textAlign='right'; ctx.font='700 11px ui-sans-serif,system-ui'; ctx.globalAlpha=.8;
    ctx.fillText(actives+'/'+z.roles.length+' ativos', x+w-12, y+ZHEAD/2+1); ctx.globalAlpha=1;
    // estações dos agentes da área
    var dc=item.deskCols, gridW=Math.min(dc,z.roles.length)*MS_W;
    var ox=x+(w-gridW)/2;
    z.roles.forEach(function(type,i){
      var col=i%dc, row=Math.floor(i/dc);
      var cx=ox+col*MS_W+MS_W/2;
      var deskBottom=bodyY+ZPAD+16+row*MS_H+MS_H-24;
      drawMiniStation(type, cx, deskBottom, t);
    });
  }

  // Moldura comum (piso + tinta + tapete + paredes com porta + letreiro).
  function drawFrame(x,y,w,h,color,emoji,name,rightText,active){
    var bodyY=y+ZHEAD, bodyH=h-ZHEAD;
    fillRoomFloor(x, bodyY, w, bodyH);
    ctx.save(); roundRect(x,bodyY,w,bodyH,8); ctx.clip();
    ctx.fillStyle=color; ctx.globalAlpha=0.12; ctx.fillRect(x,bodyY,w,bodyH);
    ctx.globalAlpha=0.16; roundRect(x+18,bodyY+14,w-36,bodyH-28,10); ctx.fill();
    ctx.restore();
    ctx.save(); ctx.lineWidth=active?3:2;
    ctx.strokeStyle = active ? color : 'rgba(120,130,145,.7)';
    if(active){ ctx.shadowColor=color; ctx.shadowBlur=12; }
    var doorW=2*PT, dl=x+w/2-doorW/2, dr=x+w/2+doorW/2;
    ctx.beginPath();
    ctx.moveTo(dl,y+h); ctx.lineTo(x+8,y+h); ctx.arcTo(x,y+h,x,y+h-8,8);
    ctx.lineTo(x,bodyY); ctx.lineTo(x+w,bodyY); ctx.lineTo(x+w,y+h-8);
    ctx.arcTo(x+w,y+h,x+w-8,y+h,8); ctx.lineTo(dr,y+h);
    ctx.stroke(); ctx.restore();
    ctx.fillStyle='rgba(0,0,0,.18)'; ctx.fillRect(dl,y+h-4,doorW,6);
    ctx.save(); roundRect(x,y,w,ZHEAD,8); ctx.clip();
    ctx.fillStyle=color; ctx.globalAlpha=active?1:0.85; ctx.fillRect(x,y,w,ZHEAD);
    ctx.restore();
    ctx.fillStyle='#0b0d12'; ctx.textAlign='left'; ctx.textBaseline='middle';
    ctx.font='800 13px ui-sans-serif,system-ui'; ctx.fillText(emoji+'  '+name, x+12, y+ZHEAD/2+1);
    if(rightText){ ctx.textAlign='right'; ctx.font='700 11px ui-sans-serif,system-ui';
      ctx.globalAlpha=.8; ctx.fillText(rightText, x+w-12, y+ZHEAD/2+1); ctx.globalAlpha=1; }
    return { bodyY:bodyY, bodyH:bodyH };
  }

  // Lobby com a logo da empresa (usa /pa/logo.png se existir; senão desenha um wordmark).
  function drawLobby(r,t){
    var x=r.x,y=r.y,w=r.w,h=r.h;
    ctx.save(); roundRect(x,y,w,h,10); ctx.clip();
    var g=ctx.createLinearGradient(x,y,x+w,y);
    g.addColorStop(0,'#1b2230'); g.addColorStop(1,'#141821'); ctx.fillStyle=g; ctx.fillRect(x,y,w,h);
    // faixa de destaque
    ctx.fillStyle='rgba(99,102,241,.25)'; ctx.fillRect(x,y,6,h);
    ctx.restore();
    ctx.strokeStyle='rgba(120,130,145,.5)'; ctx.lineWidth=1.5; roundRect(x,y,w,h,10); ctx.stroke();
    var cy=y+h/2;
    if(PA.logo && PA.logo.complete && PA.logo.naturalWidth){
      var lh=h-20, lw=lh*(PA.logo.naturalWidth/PA.logo.naturalHeight);
      ctx.drawImage(PA.logo, x+16, y+10, lw, lh);
    } else {
      // monograma
      var bs=h-24, bx=x+16, by=y+12;
      ctx.fillStyle='#6366f1'; roundRect(bx,by,bs,bs,10); ctx.fill();
      ctx.fillStyle='#fff'; ctx.font='800 '+Math.round(bs*0.5)+'px ui-sans-serif,system-ui';
      ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('SA', bx+bs/2, by+bs/2+1);
      // wordmark
      ctx.textAlign='left'; ctx.fillStyle='#e7ecf3';
      ctx.font='800 22px ui-sans-serif,system-ui'; ctx.fillText('Sala dos Agentes', bx+bs+14, cy-8);
      ctx.fillStyle='#8b96a8'; ctx.font='600 12px ui-sans-serif,system-ui';
      ctx.fillText('o escritório dos seus agentes', bx+bs+14, cy+13);
    }
    // relógio + horário à direita (cara de empresa)
    if(PA.clock && PA.clock.complete){ ctx.drawImage(PA.clock, x+w-16*2-92, y+h/2-16*2/2, 16*2, 32*2); }
    var now=new Date(), hh=('0'+now.getHours()).slice(-2)+':'+('0'+now.getMinutes()).slice(-2);
    ctx.fillStyle='#dfe5ee'; ctx.textAlign='right'; ctx.textBaseline='middle';
    ctx.font='700 18px ui-sans-serif,system-ui'; ctx.fillText(hh, x+w-18, cy);
  }

  // Área comum: reunião (pensando/reunião), cantina (almoço) ou descanso (2 PCs gamer).
  function drawCommonRoom(item, occupants, t){
    var cm=item.cm, x=item.x, y=item.y, w=item.w, h=item.h;
    var kind=cm.kind, active = (kind==='meeting'||kind==='cantina') && occupants.length>0;
    var right = kind==='meeting' ? (occupants.length+' em reunião')
      : (kind==='cantina' ? (occupants.length?occupants.length+' no almoço':'café & comida') : '2 PCs gamer');
    var b=drawFrame(x,y,w,h,cm.color,cm.emoji,cm.name,right,active);
    var cxm=x+w/2, midY=b.bodyY+b.bodyH/2;
    if(kind==='meeting'){
      // mesa de reunião ao centro
      var tw=48*2.0, th=64*2.0*0.5;
      if(PA.tableBig && PA.tableBig.complete)
        ctx.drawImage(PA.tableBig, 0,0,48,40, cxm-tw/2, midY-th/2, tw, th);
      // participantes ao redor (quem está pensando) — pés apoiados no chão da sala
      var sc=1.6, aw=16*sc, ah=32*sc;
      var seatsFeet=[
        [cxm-30, midY-th/2+6], [cxm+30, midY-th/2+6],           // atrás da mesa
        [cxm-30, midY+th/2+46], [cxm+30, midY+th/2+46],          // à frente
        [cxm-tw/2-26, midY+18], [cxm+tw/2+26, midY+18]           // laterais
      ];
      occupants.slice(0,6).forEach(function(type,i){
        var f=seatsFeet[i], img=charFor(type);
        if(img&&img.complete) ctx.drawImage(img,0,0,16,32, f[0]-aw/2, f[1]-ah, aw, ah);
        ctx.fillStyle=cssVar('--think'); ctx.beginPath(); ctx.arc(f[0]+aw/2-1, f[1]-ah-2, 3,0,7); ctx.fill();
      });
      if(!occupants.length){ ctx.fillStyle='rgba(139,150,168,.7)'; ctx.textAlign='center';
        ctx.textBaseline='middle'; ctx.font='12px ui-sans-serif'; ctx.fillText('sala livre', cxm, midY+52); }
    } else if(kind==='cantina'){
      // duas mesinhas com café + planta
      var t1=cxm-120, t2=cxm+56;
      if(PA.smallTable&&PA.smallTable.complete){ ctx.drawImage(PA.smallTable,0,0,32,32, t1, midY-20, 32*2, 32*2);
        ctx.drawImage(PA.smallTable,0,0,32,32, t2, midY-20, 32*2, 32*2); }
      if(PA.coffee&&PA.coffee.complete){ ctx.drawImage(PA.coffee,0,0,16,16, t1+16, midY-8, 16*1.6,16*1.6);
        ctx.drawImage(PA.coffee,0,0,16,16, t2+16, midY-8, 16*1.6,16*1.6); }
      if(PA.plant&&PA.plant.complete){ ctx.drawImage(PA.plant,0,0,16,32, x+w-16*2-10, y+h-32*2-6, 16*2,32*2); }
      // quem está no almoço, sentado às mesas
      var cs=1.6, caw=16*cs, cah=32*cs;
      var seats=[[t1+32, midY-10],[t1+32, midY+52],[t2+32, midY-10],[t2+32, midY+52]];
      occupants.slice(0,4).forEach(function(type,i){ var s=seats[i], img=charFor(type);
        if(img&&img.complete) ctx.drawImage(img,0,0,16,32, s[0]-caw/2, s[1]-cah, caw, cah); });
      if(!occupants.length && PA.sofa&&PA.sofa.complete)
        ctx.drawImage(PA.sofa,0,0,32,16, cxm+34, midY+34, 32*2.4,16*2.4);
    } else { // lounge / descanso: sofá + 2 PCs gamer
      if(PA.sofa&&PA.sofa.complete){ ctx.drawImage(PA.sofa,0,0,32,16, cxm-32*1.4, b.bodyY+b.bodyH-16*2.6-6, 32*2.8,16*2.8); }
      // 2 estações gamer: mesinha + PC ligado (animado)
      var frame=Math.floor(t/220)%3;
      function gamer(gx){
        if(PA.smallTable&&PA.smallTable.complete) ctx.drawImage(PA.smallTable,0,0,32,32, gx-32, midY-30, 32*2,32*2);
        var pc = PA.pcOn[frame];
        if(pc&&pc.complete) ctx.drawImage(pc,0,0,16,32, gx-16, midY-30-32*1.2+8, 16*2.2,32*2.2);
      }
      gamer(cxm-70); gamer(cxm+70);
      if(PA.plant&&PA.plant.complete){ ctx.drawImage(PA.plant,0,0,16,32, x+w-16*2-10, y+h-32*2-6, 16*2,32*2); }
    }
  }

  var HITS=[]; // áreas clicáveis das estações (para o menu de status)
  function drawOffice(cssW, cssH, t){
    ctx.imageSmoothingEnabled=false;
    HITS=[];
    drawBuildingFloor(cssW, cssH);
    var L=computeLayout(cssW);
    drawLobby(L.lobby, t);
    L.zones.forEach(function(item){ drawZone(item, t); });
    // divisória "Áreas comuns"
    ctx.fillStyle=cssVar('--muted'); ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.font='800 11px ui-sans-serif,system-ui';
    ctx.fillText('ÁREAS COMUNS', GAP+2, L.labelY);
    // realoca: pensando/reunião -> salas de reunião; almoço -> cantina
    var meeters=meetingTypes(), meetIdx=0, assign={};
    var meetIds=L.commons.filter(function(c){return c.cm.kind==='meeting';}).map(function(c){return c.cm.id;});
    meeters.forEach(function(type){ var id=meetIds[meetIdx%meetIds.length]; meetIdx++;
      (assign[id]=assign[id]||[]).push(type); });
    assign['cantina']=cantinaTypes();
    L.commons.forEach(function(item){ drawCommonRoom(item, assign[item.cm.id]||[], t); });
  }

  function drawRoom(t){
    if(view==='room'){
      var wrap = canvas.parentElement;
      var cssW = Math.max(wrap.clientWidth-20, 360);
      var sz = officeSize(cssW);
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

  // ---- menu de status manual (clique num agente) ------------------------
  var STATUS_OPTS=[
    {v:'auto', k:'🔄', label:'Automático (do chat)'},
    {v:'foco', k:'🎯', label:'Modo foco'},
    {v:'reuniao', k:'💬', label:'Ir para a reunião'},
    {v:'almoco', k:'🍽️', label:'Ir almoçar'},
    {v:'casa', k:'🏠', label:'Ir para casa'},
  ];
  var statusMenu=document.createElement('div');
  statusMenu.className='statusmenu hidden'; document.body.appendChild(statusMenu);
  var menuType=null;
  function openStatusMenu(type, clientX, clientY){
    menuType=type; var meta=rosterMeta(type); var cur=(PREFS.status&&PREFS.status[type])||'auto';
    var html='<div class="hd">'+meta.person+' · '+meta.name+'</div>';
    STATUS_OPTS.forEach(function(o){ html+='<button data-v="'+o.v+'" class="'+(o.v===cur?'on':'')+'" style="--accent:'+meta.color+'">'+
      '<span class="k">'+o.k+'</span>'+o.label+'</button>'; });
    statusMenu.innerHTML=html; statusMenu.style.setProperty('--accent',meta.color);
    statusMenu.classList.remove('hidden');
    var mw=statusMenu.offsetWidth, mh=statusMenu.offsetHeight;
    var x=Math.min(clientX, window.innerWidth-mw-8), y=Math.min(clientY, window.innerHeight-mh-8);
    statusMenu.style.left=Math.max(8,x)+'px'; statusMenu.style.top=Math.max(8,y)+'px';
  }
  function closeStatusMenu(){ statusMenu.classList.add('hidden'); menuType=null; }
  statusMenu.addEventListener('click', function(e){
    var b=e.target.closest('button'); if(!b||!menuType) return;
    setStatus(menuType, b.dataset.v); closeStatusMenu();
  });
  document.addEventListener('click', function(e){
    if(!statusMenu.classList.contains('hidden') && !statusMenu.contains(e.target) && e.target!==canvas)
      closeStatusMenu();
  });
  canvas.addEventListener('click', function(e){
    var rect=canvas.getBoundingClientRect();
    var px=(e.clientX-rect.left)*(canvas.width/rect.width)/(window.devicePixelRatio||1);
    var py=(e.clientY-rect.top)*(canvas.height/rect.height)/(window.devicePixelRatio||1);
    var hit=null;
    for(var i=0;i<HITS.length;i++){ var hh=HITS[i];
      if(px>=hh.x&&px<=hh.x+hh.w&&py>=hh.y&&py<=hh.y+hh.h){ hit=hh; break; } }
    if(hit){ e.stopPropagation(); openStatusMenu(hit.type, e.clientX, e.clientY); }
    else closeStatusMenu();
  });

  // Exposto para verificação fora do rAF (aba sem foco estrangula o loop).
  window.__renderOffice = function(forceW){
    var wrap=canvas.parentElement, cssW=forceW||Math.max((wrap?wrap.clientWidth:900)-20, 360);
    var sz=officeSize(cssW), cssH=Math.max(320,sz.h);
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

  function renderTimeline(t, showSession){
    if(!t.length){ tl.innerHTML='<div class="empty">'+
      (showSession?'nenhum handoff nos chats abertos ainda.':'nenhum handoff nesta sessão ainda.')+'</div>'; return; }
    tl.innerHTML = t.slice().reverse().map(function(e){
      var badge = e.done?'<span class="badge ok">concluído</span>':'<span class="badge live">ativo</span>';
      var sess = (showSession && e.session)
        ? '<span class="sess" title="chat '+e.session+'">'+e.session.slice(0,6)+'</span>' : '';
      return '<div class="item"><span class="time">'+hhmm(e.ts)+'</span>'+sess+
        '<span class="who">'+roleEmoji(e.from)+' '+roleName(e.from)+'</span><span class="arrow">→</span>'+
        '<span class="who">'+roleEmoji(e.to)+' '+roleName(e.to)+'</span>'+
        '<span class="desc">— '+(e.description||'')+'</span>'+badge+'</div>';
    }).join('');
  }

  // Escopo da linha do tempo: só este chat ou todos os chats abertos.
  var tlScope='one';
  document.getElementById('tlseg').addEventListener('click', function(e){
    var b=e.target.closest('button'); if(!b) return;
    tlScope=b.dataset.scope;
    Array.prototype.forEach.call(this.children,function(c){c.classList.toggle('active',c===b);});
    refreshTimeline();
  });
  function refreshTimeline(){
    if(tlScope!=='all'){ renderTimeline(S.timeline||[], false); return; }
    var qs = proj ? ('?project='+encodeURIComponent(proj)) : '';
    fetch('/timeline-all'+qs).then(function(r){return r.json();}).then(function(d){
      renderTimeline(d.timeline||[], true);
      var n=(d.sessions||[]).length;
      var lbl=document.querySelector('#tlseg button[data-scope="all"]');
      if(lbl) lbl.textContent = 'Todos os chats abertos'+(n?' ('+n+')':'');
    }).catch(function(){});
  }

  // Lista lateral: o time inteiro, agrupado pelas mesmas áreas do mapa.
  var STATUS_LBL={ foco:'🎯 foco', reuniao:'💬 reunião', almoco:'🍽️ almoço', casa:'🏠 em casa',
    thinking:'💭 em reunião', done:'✓ concluído', off:'inativo', idle:'aguardando' };
  function renderRoster(){
    var html='';
    ZONES.forEach(function(z){
      var act=0; z.roles.forEach(function(r){ var s=effState(r).status;
        if(s==='working'||s==='thinking'||s==='foco') act++; });
      html += '<div class="zhead" style="--zc:'+z.color+'"><span>'+z.emoji+' '+z.name+'</span>'+
        '<span class="zcount">'+act+'/'+z.roles.length+'</span></div>';
      z.roles.forEach(function(type){
        var st=effState(type), meta=rosterMeta(type);
        var off = st.status==='off';
        var manual = st.manual;
        var label = st.doing ? st.doing : (STATUS_LBL[st.status] || 'aguardando');
        var stcls = st.status==='working'?'working':(st.status==='thinking'||st.status==='foco'||st.status==='reuniao'?'thinking':(st.status==='done'?'done':'idle'));
        html += '<div class="card '+(off?'idle':'')+'" data-role="'+type+'" title="clique para mudar o status" style="--accent:'+meta.color+'">'+
          '<div class="r"><span class="st '+stcls+'"></span>'+
          '<div style="min-width:0"><div class="nm">'+meta.person+' · <span style="color:'+meta.color+'">'+meta.name+'</span></div>'+
          '<div class="dc" title="'+label+'">'+(manual?'✋ ':'')+label+'</div></div></div></div>';
      });
    });
    grid.innerHTML=html;
  }
  grid.addEventListener('click', function(e){
    var c=e.target.closest('[data-role]'); if(!c) return;
    var r=c.getBoundingClientRect();
    e.stopPropagation(); openStatusMenu(c.dataset.role, r.right-6, r.top);
  });

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
      refreshTimeline();
      renderRoster();
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
