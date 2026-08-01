# Referência aberta do Codex

## Snapshot estudado

O diretório local ignorado `.reference/openai-codex` aponta para o commit
`6751b54cae32b23786001e2414d749a9916201e1`, de 1 de agosto de 2026, do
repositório [openai/codex](https://github.com/openai/codex).

A referência serve para confirmar protocolos e semântica. Nenhum crate, pacote,
arquivo, banco, processo ou executável desse workspace participa do build ou do
runtime deste aplicativo.

## Elementos estudados

- `codex-rs/login`: parâmetros OAuth, PKCE, callback local, troca, renovação e
  revogação;
- autenticação do core: claims de conta e headers necessários para uma sessão
  ChatGPT;
- cliente de modelos: endpoint e forma autoritativa `{ "models": [...] }`;
- cliente Responses: request, eventos SSE e itens de mensagem, raciocínio,
  função e pesquisa web;
- leitura de limites da conta: endpoint e semântica das janelas de uso;
- políticas e ferramentas: inspiração para limites, aprovações e cancelamento.

O login nativo foi validado em runtime antes desta reescrita. Essa validação
confirma o protocolo OAuth, não autoriza dependência da CLI nem compatibilidade
com o armazenamento dela.

O catálogo declara explicitamente `0.146.0` como versão de compatibilidade do
cliente no parâmetro `client_version`. Esse contrato acompanha a versão estável
do protocolo estudado e é independente da versão comercial do aplicativo.

## Decisões próprias

Este projeto implementa do zero:

- domínio IPC menor e fechado;
- banco SQLite e histórico próprios;
- envelope de credencial privado do aplicativo;
- cliente HTTPS/SSE com limites próprios;
- loop do agente e catálogo reduzido de ferramentas;
- perfis de permissão e aprovação;
- UI e reducers TypeScript.

Deliberadamente não foram adotados `app-server`, JSONL por `stdio`, config da
CLI, `CODEX_HOME`, rollout files, MCP, colaboração, aliases antigos, migrações ou
fallbacks de protocolo.

## Política de atualização

Antes de alterar OAuth ou provider:

1. atualizar o clone ignorado da referência;
2. registrar o commit estudado neste arquivo;
3. comparar apenas o contrato relevante;
4. implementar a mudança no domínio próprio;
5. executar testes de fronteira e validação live limitada.

Mudanças da referência nunca são copiadas mecanicamente e nunca criam um caminho
de compatibilidade automática.
