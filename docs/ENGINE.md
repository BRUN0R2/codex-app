# Contrato do engine

## Objetivo

O `NativeEngine` é o dono da composição do aplicativo. Ele concentra
autenticação, armazenamento, políticas e catálogo de ferramentas atrás de
operações tipadas. O Codex CLI é somente um adaptador temporário para provider,
modelos, configuração e execução de ferramentas.

## Implementações

| Implementação | Seleção | Responsabilidade |
| --- | --- | --- |
| `NativeEngine` | padrão | auth, composição, SQLite, ferramentas, permissões e provider |
| `CodexCompatibilityEngine` | `CODEX_APP_ENGINE=compatibility` | diagnóstico direto do protocolo oficial |

O descritor expõe tipo, provider, autenticação, capacidades e disponibilidade da
ponte. Disponibilidade não significa processo ativo: no engine nativo, a ponte é
iniciada pela primeira operação compatível e encerrada no ciclo de vida do app ou
antes do logout. Em uma sessão autenticada, a UI antecipa essa operação para
carregar configuração e modelos em segundo plano; autenticação continua nativa e
independente da ponte.

## Operações

A superfície é uma enumeração fechada:

- conta: ler, consultar limites de uso, entrar com ChatGPT, cancelar login e sair;
- tarefa: listar, iniciar, retomar, renomear, arquivar, enviar turno e interromper;
- configuração: ler, ler requisitos, escrever e escrever em lote;
- segurança: consultar a prontidão do sandbox do Windows sem alterá-lo;
- modelos: listar;
- aprovação: responder uma solicitação pendente.

Somente o adaptador de compatibilidade conhece métodos como `thread/list`,
`thread/resume`, `turn/start` ou `model/list`. A UI invoca comandos Tauri pequenos
e trabalha com tipos de domínio. A listagem usa paginação limitada, ordenação por
recência e exclui tarefas arquivadas.

`account/rateLimits/read` também fica atrás de uma operação fechada e sem
parâmetros. A sessão o consulta apenas para contas ChatGPT, de forma deduplicada,
e passa a acompanhar `account/rateLimits/updated`; não existe RPC arbitrário nem
estimativa local de cota.

## Autenticação nativa

`ChatGptAuth` implementa diretamente o fluxo estudado em `codex-rs/login`:

1. gera estado aleatório e PKCE S256;
2. escuta `127.0.0.1` nas portas oficiais 1455 ou 1457;
3. entrega somente a URL de autorização à UI;
4. valida método, caminho, estado, duplicatas e limites do callback;
5. troca o código em `https://auth.openai.com/oauth/token`;
6. grava a sessão em um cofre local criptografado;
7. renova preventivamente e revoga no logout.

O callback expira em dez minutos, aceita no máximo 32 conexões e limita os
cabeçalhos a 16 KiB. Requisições OAuth e revogação possuem timeouts próprios.
Login, renovação e logout são serializados por um dono único; cancelamento e
trocas externas de credencial são tratados explicitamente.

Tokens são tipos redigidos e zerados no descarte. Eles não entram em props,
eventos Tauri, logs, diagnósticos ou SQLite. A UI recebe somente email, plano,
estado de renovação e resultados sem segredos.

## Armazenamento de credenciais

O backend usa o contrato `Secrets` adotado pelo Codex atual no Windows:

- arquivo: `CODEX_HOME/secrets/codex_auth.age`;
- envelope: age com recipient scrypt e schema versionado;
- entrada: `global/CODEX_AUTH`, contendo o registro JSON compatível;
- chave: 256 bits aleatórios, codificados em Base64;
- Credential Manager: serviço `codex` e conta `secrets|` mais os primeiros 16
  dígitos do SHA-256 do `CODEX_HOME` canônico.

Somente a chave curta entra no Credential Manager; o tamanho dos tokens não fica
limitado pelo store do Windows. Plaintext e tipos de segredo são zerados no
descarte, e a gravação do envelope usa arquivo temporário sincronizado antes da
substituição.

O app não lê nem escreve `auth.json`. A ponte é iniciada com keyring e
`secret_auth_storage` habilitado para consumir o mesmo cofre sem copiá-lo.

## Persistência nativa

O schema SQLite atual tem versão 1:

- `engine_threads`: identificador da tarefa, workspace e timestamps;
- `engine_events`: sequência, tarefa opcional, nome da operação e timestamp.

O payload das mensagens e as credenciais não são persistidos nessa base.
Migrações futuras devem ser explícitas, transacionais e monotônicas.

## Ferramentas e sandbox

`ToolRegistry` classifica ferramentas como leitura, escrita no workspace,
processo ou rede. `PermissionProfile` expressa os presets apresentados pela UI.
A execução concreta e a aplicação efetiva do sandbox ainda pertencem à ponte.
O engine já consulta `windowsSandbox/readiness` e expõe `ready`, `notConfigured`
ou `updateRequired`; setup e elevação não são iniciados implicitamente.

## Critérios para remover a ponte

A autenticação nativa já não depende da ponte. Para removê-la do produto ainda
faltam, em conjunto:

1. provider direto com streaming e catálogo de modelos;
2. executor nativo de ferramentas com cancelamento;
3. sandbox aplicado por plataforma;
4. aprovações correlacionadas e testadas;
5. persistência e retomada completas de tarefas;
6. fixtures de paridade e testes end-to-end.
