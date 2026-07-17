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

## Atualização automática

O app empacotado checa por novas versões no **GitHub Releases** deste repo
(`mayccoisa/sala-dos-agentes`) toda vez que abre. Se houver versão nova:

1. avisa por notificação e **baixa em segundo plano**;
2. ao terminar, oferece **reiniciar agora** para aplicar (ou instala sozinho ao fechar).

Nada disso roda no modo `node server.mjs` nem no `electron .` de dev — só no `.exe`
instalado (`app.isPackaged`). Falha de rede na checagem é silenciosa.

### Publicar uma nova versão (release)

Para o auto-update enxergar a atualização, cada release precisa subir o instalador
**e** o `latest.yml` que o electron-builder gera. Passo a passo:

```bash
cd desktop
# 1. suba a versão em package.json (ex.: 0.1.0 -> 0.1.1)
npm version patch --no-git-tag-version
# 2. gere e publique o release no GitHub (cria a release + anexa .exe e latest.yml)
export GH_TOKEN=<token com escopo repo>   # no PowerShell: $env:GH_TOKEN="..."
npm run release
```

`npm run release` = `electron-builder --win --publish always`. Ele cria/atualiza a
release da tag correspondente no GitHub e anexa os artefatos. Os apps 0.1.0 já
instalados passam a ver a 0.1.1 na próxima abertura.

## Estrutura

- `server.mjs` — servidor local + página (Fases 1–3). Fonte única.
- `assets/` — spritesheet CC0 "Roguelike Characters" da Kenney (ver `CREDITS.txt`).
- `desktop/` — wrapper Electron que reaproveita o `server.mjs` (`main.mjs`,
  `build/icon.ico`). `node_modules/` e `dist/` não são versionados.
