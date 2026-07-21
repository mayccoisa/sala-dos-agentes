# Sala dos Agentes v0.11.0 — Escritório mais bonito

Uma leva grande de melhorias visuais no mapa do escritório, além de ajustes de usabilidade.

## ✨ Novidades

- **🚪 Portas entre as salas** — cada sala tem uma porta na parede ligando à vizinha, que **acende** com a cor da área quando tem alguém trabalhando dentro.
- **🪵 Piso de madeira por sala** — assoalho de verdade (tábuas com veio e nós), um tom por área, no lugar do piso liso.
- **🎨 Avatares nas cores originais** — sem mais a lavagem de cor por cima do personagem; cada agente aparece com o visual próprio.
- **🖥️ Ferramentas na mesa** — o PC, os livros e o quadro de cada agente ficam **em cima da mesa**, não mais sobre o personagem.
- **😴 Feedback de parado** — um "z" flutuante sobe do agente ocioso, em vez de deixá-lo apagado. Trabalhando continua com o halo pulsante.
- **🧭 Área "Produto"** — a antiga "Diretoria" virou "Produto", refletindo a área de PM (Boss, PM Lead, PM Growth, PM Core).
- **🗂️ Lista lateral recolhível** — as salas na lateral agrupam os agentes e abrem/fecham; abrem sozinhas quando há gente ativa.
- **🏷️ Título na barra de cima** — mostra o que você está vendo (Sala ou Diagrama).

## 🔧 Ajustes

- Barra do topo mais enxuta: a marca aparece só no letreiro do mapa.
- Scrollbars no tom da interface e mais finas; dropdowns nativos legíveis no tema escuro.
- Integração com o Slack: passo a passo detalhado de como gerar o token, e o campo trava quando conectado (desligue a sincronização para trocar).

## 🔒 Suas preferências continuam salvas

Token do Slack, sala, avatares e status ficam em `~/.claude/agent-room-prefs.json`, na sua pasta de usuário. **A atualização não mexe nisso** — você continua conectado.

## 📥 Instalar / atualizar

- **Já tem instalado:** nada a fazer — o app se atualiza sozinho na próxima abertura.
- **Primeira vez:** baixe o `Sala-dos-Agentes-Setup-0.11.0.exe` abaixo e instale (por-usuário, sem admin). Não é assinado → SmartScreen: *Mais informações → Executar assim mesmo*.
