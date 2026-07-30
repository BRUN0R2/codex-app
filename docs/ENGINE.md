# Contrato do engine

## Objetivo

O `NativeEngine` é a base própria do aplicativo. Ele concentra composição,
armazenamento, políticas e catálogo de ferramentas atrás de operações tipadas.
O Codex CLI é um adaptador temporário para as capacidades ChatGPT que ainda não
possuem uma integração pública direta equivalente.

Esta etapa não afirma que a inferência já é totalmente nativa: autenticação,
modelo, streaming e execução de ferramentas ainda passam pela ponte. A fronteira
foi criada para que isso possa mudar sem reescrever a interface.

## Implementações

| Implementação | Seleção | Responsabilidade |
| --- | --- | --- |
| `NativeEngine` | padrão | composição, SQLite, ferramentas, permissões, auth e provider |
| `CodexCompatibilityEngine` | `CODEX_APP_ENGINE=compatibility` | diagnóstico direto do protocolo oficial |

O descritor retornado à UI informa `kind`, provider, autenticação, capacidades,
transporte e se uma ponte está ativa. A tela de configurações mostra esses dados
para evitar uma falsa impressão de execução puramente nativa.

## Operações

A superfície é uma enumeração fechada:

- conta: ler, entrar com ChatGPT e sair;
- tarefa: iniciar, enviar turno e interromper;
- configuração: ler, escrever e escrever em lote;
- modelos: listar;
- aprovação: responder uma solicitação pendente.

Somente o adaptador de compatibilidade conhece nomes como `turn/start` ou
`model/list`. A UI invoca comandos Tauri `engine_*` e trabalha com tipos de
domínio.

## Autenticação

`ChatGptAuth` não implementa OAuth, não abre arquivos de credenciais e não
aceita operações de inferência. Ele delega o fluxo oficial à ponte e entrega à UI
somente:

- URL de autorização;
- identificador do fluxo;
- estado público da conta;
- evento de conclusão.

Tokens não entram em props, eventos Tauri, logs do engine nem SQLite. Também não
há fallback para chave de API.

## Persistência

O schema SQLite atual tem versão 1:

- `engine_threads`: identificador da tarefa, workspace e timestamps;
- `engine_events`: sequência, tarefa opcional, nome da operação e timestamp.

O payload da mensagem não é persistido. Migrações futuras devem ser explícitas,
transacionais e monotônicas; nunca devem alterar `user_version` sem aplicar o
schema correspondente.

## Ferramentas e sandbox

`ToolRegistry` descreve ferramentas por identificador e risco:

- leitura;
- escrita no workspace;
- processo;
- rede.

`PermissionProfile` expressa os presets que a interface apresenta. Nesta etapa,
a execução concreta e a aplicação efetiva do sandbox ainda pertencem à ponte.
A próxima implementação nativa deve verificar o risco da ferramenta contra o
perfil antes de iniciar qualquer ação externa.

## Critérios para remover a ponte

A ponte só pode deixar de ser requisito quando houver, ao mesmo tempo:

1. autenticação ChatGPT por contrato público e suportado;
2. provider com streaming e catálogo de modelos;
3. executor nativo de ferramentas com cancelamento;
4. sandbox realmente aplicado por plataforma;
5. aprovações correlacionadas e testadas;
6. persistência e retomada de tarefas;
7. fixtures de compatibilidade e testes end-to-end.

Até lá, falhar visivelmente é preferível a capturar credenciais ou depender de
endpoints privados.
