# Próximos passos

## Concluído

- [x] `NativeEngine`, contratos de domínio e ponte isolada sob demanda.
- [x] Login ChatGPT nativo com PKCE, cancelamento, renovação e revogação.
- [x] Cofre criptografado compatível com o Codex, sem tokens no IPC ou SQLite.
- [x] Chat com streaming, interrupção, anexos, imagens coladas e aprovações.
- [x] Shell, painel de ambiente, seletores e configurações modulares.
- [x] Viabilidade OAuth validada ao vivo sem iniciar o Codex CLI.
- [x] Login, persistência após reinício e leitura da sessão pela ponte validados.
- [x] Modelos e configuração pré-carregados em segundo plano, com concorrência
  deduplicada e validação ao vivo sem interação.
- [x] Projetos persistidos e tarefas paginadas, retomáveis, renomeáveis e
  arquiváveis.

## Engine

- [ ] Validar logout integrado ao vivo sem deixar sessão residual.
- [ ] Implementar provider direto com paridade de modelos e streaming.
- [ ] Implementar executor nativo de ferramentas com cancelamento.
- [ ] Aplicar sandbox por SO antes de executar cada ferramenta.
- [ ] Persistir e retomar tarefas pelo armazenamento nativo.
- [ ] Remover a ponte após testes de paridade e end-to-end.

## Produto

- [ ] Renderizar diffs e toda a matriz de itens de ferramenta.
- [ ] Completar as categorias de configuração suportadas.
- [ ] Preparar assinatura, instalador, atualização e telemetria opt-in.
