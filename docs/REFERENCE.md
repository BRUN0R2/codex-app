# Estudo da referência oficial

## Snapshot analisado

O repositório [openai/codex](https://github.com/openai/codex) foi baixado em
`.reference/openai-codex` e fixado no commit
`6219b7c40fc9c702c0aef9964e72b492558f60e4`, de 30 de julho de 2026. A cópia é
somente material de estudo e permanece fora do Git deste projeto.

As áreas relevantes foram lidas diretamente no snapshot:

- `codex-rs/app-server`: transporte, handshake, requisições e notificações;
- `codex-rs/app-server-protocol`: contratos gerados e tipos de entrada;
- `codex-rs/core`: configuração, autenticação e catálogo de modelos;
- `codex-rs/login`: fluxo ChatGPT administrado pelo runtime;
- testes do `app-server`: sequência de inicialização e formato das respostas.

## Contratos adotados

- O transporte local é JSONL por `stdio`, sem framing `Content-Length`.
- O cliente envia `initialize`, aguarda a resposta e então envia `initialized`.
- Login usa `account/login/start` com `type: "chatgpt"`; tokens pertencem ao
  runtime oficial e nunca atravessam a interface deste aplicativo.
- Conversas usam `thread/start`, `turn/start` e `turn/interrupt`.
- Entradas são `text`, `localImage` ou `mention`.
- Configuração usa `config/read`, `config/value/write` e `config/batchWrite`.
- Modelo, esforços e tiers de serviço vêm de `model/list`.
- Solicitações do servidor são respondidas pelo mesmo `id`; métodos desconhecidos
  não recebem aprovação automática.

## Decisões de implementação

O projeto usa a referência para entender responsabilidades e semântica, sem
copiar componentes privados nem incorporar o workspace Rust inteiro. O snapshot
contém dezenas de crates internos fortemente conectados; tratá-lo como uma
biblioteca pequena apenas deslocaria o acoplamento para dentro deste app.

Foi criada uma base própria em `src-tauri/src/engine`: contrato `AgentEngine`,
operações de domínio, `NativeEngine`, SQLite, registro de ferramentas e política
de permissões. O protocolo oficial agora fica atrás de
`CodexCompatibilityEngine`, em vez de ser a arquitetura do aplicativo.

O login ChatGPT continua delegado ao runtime oficial. Não foi criado OAuth
paralelo, leitura de credenciais ou acesso a endpoints privados. O frontend recebe
tipos de domínio e eventos, sem acesso a stdin, processo filho ou tokens.

O processo da ponte é supervisionado por um único dono Rust, com I/O assíncrono,
timeout limitado e correlação de respostas. Essa ponte ainda executa inferência e
ferramentas nesta fase; sua presença é exposta nos diagnósticos da interface.

## Estudo visual ao vivo

O Codex Desktop instalado foi inspecionado sem enviar mensagens nem alterar
preferências. Foram verificados shell, compositor, painel de ambiente, seletor e
os três submenus, menu da conta e página de configurações.

Padrões reproduzidos:

- sidebar de 273 px em janela ampla e conteúdo de chat centralizado;
- compositor compacto, expansível e com ações agrupadas nas extremidades;
- permissão resumida como intenção (`Aprovar por mim`, `Acesso completo` ou
  `Personalizado`) e detalhes técnicos concentrados nas configurações;
- popover de permissões com contexto, descrição por opção, seleção visível e
  acesso direto à configuração avançada;
- menu raiz de 226 px e submenus em cascata alinhados pela base;
- listas compactas com check, descrições apenas quando agregam contexto e reset
  separado por divisor;
- configurações em página inteira, busca lateral e conteúdo central de 768 px;
- canvas `#181818`, sidebar `#202020`, superfícies `#2D2D2D`, seleção
  `#313131` e destaque de permissão próximo de `#FF8549`.

A escala foi implementada no CSS do aplicativo. Não existe código que altere DPI,
zoom do WebView ou escala do sistema operacional.

## Atualização da referência

Antes de ampliar uma capacidade, compare o contrato com a versão oficial atual,
registre o novo commit estudado e valide a fronteira alterada ao vivo. Mudanças do
snapshot nunca devem ser copiadas mecanicamente para este repositório.
