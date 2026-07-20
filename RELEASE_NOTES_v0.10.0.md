# Sala dos Agentes v0.10.0 — Status no Slack

Agora o seu status pode sincronizar com o Slack.

## ✨ Novidades

- **🟢 "Meu status"** — um controle novo no topo do app: Disponível, 🎯 Foco, 💬 Reunião, 🍽️ Almoço, 🏠 Casa.
- **🔗 Sincroniza com o Slack** — ligando a integração (em ⚙︎ Personalizar → Integração com o Slack), cada mudança atualiza no Slack o recado, o emoji e o "não perturbe" (ex.: Foco liga o DND por 1h, Almoço por 45min).
- **🔒 Opt-in e local** — o app continua sem falar com ninguém por padrão. Você cola um **token de usuário do Slack** (escopo `users.profile:write` + `dnd:write`) uma vez, liga a sincronização, e pronto. O token fica salvo **só no seu PC** e nunca sai para lugar nenhum além do próprio Slack.

### Como configurar
1. Crie um app em https://api.slack.com/apps → adicione os *User Token Scopes* `users.profile:write` e `dnd:write` → instale no seu workspace.
2. Copie o **User OAuth Token** (`xoxp-…`).
3. No app: ⚙︎ Personalizar → Integração com o Slack → cole o token → **Testar** → **Ligar sincronização** → **Salvar**.

## 📥 Instalar / atualizar

- **Já tem instalado:** nada a fazer — o app se atualiza sozinho na próxima abertura.
- **Primeira vez:** baixe o `Sala-dos-Agentes-Setup-0.10.0.exe` abaixo e instale (por-usuário, sem admin). Não é assinado → SmartScreen: *Mais informações → Executar assim mesmo*.

---
*Ferramenta local: só lê os transcripts que o Claude Code grava no seu PC. A única saída externa é o Slack, e só quando você liga.*
