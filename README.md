# Sala dos Agentes

Observador local e lúdico dos agentes do Claude Code: mostra numa "salinha" o que
cada papel/agente está fazendo, **quem chamou quem** e a linha do tempo dos handoffs.

- **Zero token de API** — só *lê* os transcripts JSONL que o Claude Code já grava em
  `~/.claude/projects/`. Deixar aberto não custa nada.
- **Por máquina** — mostra os agentes rodando *naquele* PC.

## Rodar sem instalar (precisa Node.js)

```bash
node server.mjs      # abre em http://localhost:4599
```

Opções: `PORT=4599`, passar `<sessionId>` como argumento, ou
`AGENT_ROOM_PROJECT=<pasta|caminho>` para forçar outro projeto. Por padrão detecta
o projeto sozinho e a UI tem um seletor de projeto.

## App instalável (Windows, não precisa Node no PC alvo)

```bash
cd desktop
npm install          # baixa Electron (uma vez)
npm run dist         # gera dist/Sala dos Agentes Setup 0.1.0.exe
```

Copie o `.exe` para o PC de destino e instale (é por-usuário, não pede admin).
O instalador **não é assinado** → o Windows SmartScreen avisa: *Mais informações →
Executar assim mesmo*.

## Estrutura

- `server.mjs` — servidor local + página (Fases 1–3). Fonte única.
- `assets/` — spritesheet CC0 "Roguelike Characters" da Kenney (ver `CREDITS.txt`).
- `desktop/` — wrapper Electron que reaproveita o `server.mjs` (`main.mjs`,
  `build/icon.ico`). `node_modules/` e `dist/` não são versionados.
