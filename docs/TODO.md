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
- [x] Timeline semântica com comandos, diffs, imagens e progresso do turno.
- [x] Todos os `ThreadItem` e `UserInput` do snapshot oficial atual possuem
  parsing explícito e visualização dedicada.
- [x] Solicitações interativas do app-server possuem fila, parsing, respostas e
  renderização inline tipados, incluindo permissões granulares e MCP.
- [x] Notificações, erros e solicitações interativas são roteados por `threadId`;
  tarefas em segundo plano não alteram a conversa ou aprovação visível.
- [x] Categorias de configuração suportadas possuem páginas modulares, política
  administrativa tipada e preferências visuais persistidas.
- [x] Prontidão do sandbox do Windows é consultada e exibida sem setup implícito.
- [x] Preparação do sandbox possui confirmação, política administrativa e
  conclusão assíncrona tipada, sem elevação ou fallback automáticos.
- [x] Avisos de diretórios graváveis por todos possuem parsing limitado, decisão
  explícita e persistência versionada, sem correção automática de ACLs.
- [x] Avisos globais de configuração possuem parsing integral, fila limitada,
  deduplicação e localização visível, sem correção automática do arquivo.
- [x] Avisos, Guardian e deprecações possuem escopo oficial, retenção limitada
  por tarefa, omissões visíveis e deduplicação especial compatível com o Codex.
- [x] Verificação de modelo `trustedAccessForCyber` possui parsing fechado,
  orientação oficial e isolamento por tarefa.
- [x] Limites da conta usam snapshot oficial, atualização esparsa e cartão de uso
  responsivo sem polling, incluindo o aviso de esgotamento junto ao compositor.

## Engine

- [ ] Validar logout integrado ao vivo sem deixar sessão residual.
- [ ] Implementar provider direto com paridade de modelos e streaming.
- [ ] Implementar executor nativo de ferramentas com cancelamento.
- [ ] Aplicar sandbox por SO antes de executar cada ferramenta.
- [ ] Persistir e retomar tarefas pelo armazenamento nativo.
- [ ] Remover a ponte após testes de paridade e end-to-end.

## Produto

- [ ] Implementar `model/safetyBuffering/updated` com estado de espera e retry
  seguro por fork, preservando a entrada original.
- [ ] Preparar assinatura, instalador, atualização e telemetria opt-in.
