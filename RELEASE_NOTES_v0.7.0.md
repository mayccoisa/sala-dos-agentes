# Sala dos Agentes v0.7.0 — Lista ao lado do mapa + linha do tempo de todos os chats

## ✨ Novidades

- **📋 Lista de agentes ao lado do mapa** — saiu de baixo e virou uma coluna à direita, agrupada pelas mesmas áreas do escritório (Diretoria, Pesquisa, Dados, Chamados), com contador de ativos por área. Em telas estreitas ela volta a empilhar embaixo.
- **🕒 Linha do tempo de todos os chats abertos** — antes ela mostrava só o chat atual (o `.jsonl` mais recente). Agora há um alternador **"Este chat" / "Todos os chats abertos"**, que junta os handoffs de todas as sessões com atividade na última hora.
- **🏷️ Origem do handoff** — no modo "todos", cada linha mostra de qual chat veio.

Por baixo: o resultado de cada sessão é cacheado pela data de modificação dos arquivos, então juntar vários chats não pesa no polling.

## 📥 Instalar / atualizar

- **Já tem instalado:** nada a fazer — o app se atualiza sozinho na próxima abertura.
- **Primeira vez:** baixe o `Sala-dos-Agentes-Setup-0.7.0.exe` abaixo e instale (por-usuário, sem admin). Não é assinado → SmartScreen: *Mais informações → Executar assim mesmo*.

---
*Ferramenta local, sem token de API: só lê os transcripts que o Claude Code já grava no seu PC.*
