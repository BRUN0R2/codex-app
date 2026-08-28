# TODO

- [ ] Implementar Code Mode como subsistema próprio e isolado — runtime
  JavaScript sandboxed, protocolo tipado, limites de heap/tempo, delegação,
  yield/wait e cancelamento — antes de honrar catálogos `code_mode_only`; não
  depender de build, processo, armazenamento ou configuração do Codex CLI.
- [ ] Projetar multiagente v2 e orçamento de tokens como subsistemas nativos com
  ownership, cancelamento, persistência e testes de fronteira antes de anunciar
  Ultra real ao usuário.
- [ ] Avaliar o transporte Responses WebSocket em módulo isolado e adotá-lo
  somente com equivalência comprovada de SSE, reconexão, ordenação e
  cancelamento.

- [ ] Após a renovação da cota indicada pelo provider (`HTTP 429`,
  `usage_limit_reached`), medir a latência do primeiro delta e validar uma
  decisão de aprovação ao vivo em uma tarefa descartável já autorizada. Não
  acionar a interrupção enquanto vigorar a instrução de não usar **Stop**.
- [ ] Quando a instância release canônica puder ser fechada, repetir nela a
  medição autenticada de startup/memória. O build atualizado e uma medição com
  identificador/dados isolados já foram registrados em `PERFORMANCE.md` em 21
  de agosto de 2026.
- [ ] Incorporar OpenAI Sans somente se houver licença pública de
  redistribuição ou se um arquivo autorizado for fornecido. Até lá, preservar a
  pilha de fallback métrica documentada em `REFERENCE.md`.
- [ ] Inserir os quatro secrets reais de publicação descritos em
  `docs/RELEASE.md` quando o certificado do distribuidor estiver disponível.
