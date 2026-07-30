# Próximos passos

## Concluído nesta base

- [x] Contrato `AgentEngine` e operações de domínio fechadas.
- [x] `NativeEngine` como composição padrão.
- [x] Adaptador Codex isolado como ponte de compatibilidade.
- [x] Módulos de autenticação, provider, ferramentas, sandbox e SQLite.
- [x] Login oficial ChatGPT sem expor tokens à UI.
- [x] Chat com streaming, interrupção, anexos, imagens coladas e aprovações.
- [x] Shell modular, painel de ambiente, seletor em cascata e configurações.
- [x] Descritor e diagnósticos que tornam a ponte visível.

## Migração do engine

- [ ] Definir protocolo nativo de eventos e fixtures independentes do Codex.
- [ ] Implementar executor de ferramentas com cancelamento e saída estruturada.
- [ ] Aplicar `PermissionProfile` antes de cada ferramenta, com sandbox por SO.
- [ ] Persistir e retomar tarefas pelo armazenamento nativo.
- [ ] Implementar provider direto quando houver contrato ChatGPT público e
  suportado com paridade de login, modelos e streaming.
- [ ] Remover o requisito do Codex CLI somente depois dos testes de paridade.

## Produto

- [ ] Listar, retomar, renomear e arquivar tarefas existentes.
- [ ] Renderizar toda a matriz de itens, incluindo diffs e ferramentas.
- [ ] Criar testes E2E contra uma ponte controlada e testes do engine sem ponte.
- [ ] Completar categorias de configuração conforme contratos suportados.
- [ ] Preparar assinatura, instalador, atualização e telemetria estritamente
  opt-in.
