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
- `codex-rs/secrets` e `codex-rs/keyring-store`: cofre criptografado e chave do
  sistema operacional;
- testes do `app-server`: sequência de inicialização e formato das respostas.

## Contratos adotados

- O transporte local é JSONL por `stdio`, sem framing `Content-Length`.
- O cliente envia `initialize`, aguarda a resposta e então envia `initialized`.
- O login OAuth usa o cliente, os escopos, flags, portas e callback observados em
  `codex-rs/login`; tokens nunca atravessam a interface deste aplicativo.
- Conversas usam `thread/list`, `thread/start`, `thread/resume`,
  `thread/name/set`, `thread/archive`, `turn/start` e `turn/interrupt`.
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

O login do produto agora pertence ao backend Rust. A implementação reproduz o
contrato observado e mantém tokens em tipos redigidos. No snapshot atual,
`SecretAuthStorage` é estável e habilitado por padrão no Windows: o registro fica
em `secrets/codex_auth.age`, enquanto o Credential Manager guarda somente a
chave curta associada ao `CODEX_HOME`. O app implementa esse backend em módulos
próprios e preserva o formato consumido pelo `app-server`.

O processo da ponte é supervisionado por um único dono Rust, com I/O assíncrono,
timeout limitado e correlação de respostas. Ele não participa da autenticação e
só nasce quando provider, modelos ou configuração são solicitados.

## Estudo visual ao vivo

O Codex Desktop instalado foi inspecionado sem enviar mensagens nem alterar
preferências. Foram verificados shell, compositor, painel de ambiente, seletor e
os três submenus, menu da conta e página de configurações.

Padrões reproduzidos:

- sidebar de 273 px em janela ampla e conteúdo de chat centralizado;
- projetos com raiz selecionável, ações no hover, tarefas indentadas e seção de
  recentes;
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

## Validação do login nativo

Em 30 de julho de 2026, uma prova efêmera escrita em Rust reproduziu diretamente
o fluxo observado em `codex-rs/login`, sem iniciar nem vincular o Codex CLI. O
teste executou, em sequência:

- PKCE S256 e estado aleatório;
- autorização no navegador com callback em `localhost:1455`;
- troca do código em `https://auth.openai.com/oauth/token`;
- leitura estrutural das claims de identidade, conta e plano;
- renovação pelo `refresh_token`;
- revogação em `https://auth.openai.com/oauth/revoke`.

O servidor aceitou também o `originator` próprio `codex_desktop_next`. O resultado
observado foi `login=true`, `refresh=true` e `revoke=true`. Nenhuma credencial foi
persistida, exibida ou enviada ao frontend; o processo descartou os valores
sensíveis ao terminar. A página de conclusão no navegador foi verificada ao vivo.

Essa evidência confirmou o protocolo antes da integração. A implementação do
produto adicionou armazenamento durável, detecção de alterações concorrentes,
cancelamento e ownership serializado.

Após a integração, o fluxo real foi repetido pela interface. Uma sessão maior
que o limite do Credential Manager foi gravada em um envelope de 4.797 bytes,
sem arquivos temporários residuais. O app foi encerrado e iniciado novamente,
reconheceu a conta sem novo login e o `app-server` iniciado com
`secret_auth_storage=true` leu o mesmo cofre e retornou 7 modelos.

Depois do aquecimento assíncrono, uma nova inicialização foi observada sem abrir
o seletor nem acionar outro controle. Em duas execuções limpas, a ponte filha
surgiu de três a quatro segundos após o processo da UI e o painel de ambiente
passou para `7 modelos disponíveis` automaticamente. O logout remoto permanece
no checklist para não invalidar a sessão validada.

## Atualização da referência

Antes de ampliar uma capacidade, compare o contrato com a versão oficial atual,
registre o novo commit estudado e valide a fronteira alterada ao vivo. Mudanças do
snapshot nunca devem ser copiadas mecanicamente para este repositório.
