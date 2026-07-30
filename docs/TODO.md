# Próximos passos

## Concluído nesta base

- [x] Contrato `AgentEngine` e operações de domínio fechadas.
- [x] `NativeEngine` como composição padrão.
- [x] Adaptador Codex isolado como ponte de compatibilidade.
- [x] Módulos de autenticação, provider, ferramentas, sandbox e SQLite.
- [x] Login ChatGPT pela ponte sem expor tokens à UI.
- [x] Viabilidade do login nativo validada com PKCE, renovação e revogação.
- [x] Chat com streaming, interrupção, anexos, imagens coladas e aprovações.
- [x] Shell modular, painel de ambiente, seletor em cascata e configurações.
- [x] Descritor e diagnósticos que tornam a ponte visível.

## Migração do engine

- [ ] Implementar login nativo com armazenamento seguro no Windows.
- [ ] Integrar renovação, logout e estado da conta ao `NativeEngine`.
- [ ] Definir protocolo nativo de eventos e fixtures independentes do Codex.
- [ ] Implementar executor de ferramentas com cancelamento e saída estruturada.
- [ ] Aplicar `PermissionProfile` antes de cada ferramenta, com sandbox por SO.
- [ ] Persistir e retomar tarefas pelo armazenamento nativo.
- [ ] Validar e implementar provider direto com paridade de modelos e streaming.
- [ ] Remover o requisito do Codex CLI somente depois dos testes de paridade.

## Produto

- [ ] Listar, retomar, renomear e arquivar tarefas existentes.
- [ ] Renderizar toda a matriz de itens, incluindo diffs e ferramentas.
- [ ] Criar testes E2E contra uma ponte controlada e testes do engine sem ponte.
- [ ] Completar categorias de configuração conforme contratos suportados.
- [ ] Preparar assinatura, instalador, atualização e telemetria estritamente
  opt-in.
