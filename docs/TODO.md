# TODO

- [ ] Após a renovação da cota indicada pelo provider (`HTTP 429`,
  `usage_limit_reached`), medir a latência do primeiro delta e validar uma
  decisão de aprovação ao vivo em uma tarefa descartável já autorizada. Não
  acionar a interrupção enquanto vigorar a instrução de não usar **Stop**.
- [ ] Após reiniciar o Codex para carregar o MCP `chrome-devtools`, capturar um
  trace de uma conversa de estresse no build de produção e registrar Long Tasks,
  heap, quantidade de nós DOM, INP e estabilidade do scroll em `PERFORMANCE.md`.
- [ ] Inserir os quatro secrets reais de publicação descritos em
  `docs/RELEASE.md` quando o certificado do distribuidor estiver disponível.
