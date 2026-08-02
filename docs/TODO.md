# TODO

- [ ] Após a renovação da cota indicada pelo provider (`HTTP 429`,
  `usage_limit_reached`), medir a latência do primeiro delta e validar uma
  decisão de aprovação ao vivo em uma tarefa descartável já autorizada. Não
  acionar a interrupção enquanto vigorar a instrução de não usar **Stop**.
- [ ] Inserir os quatro secrets reais de publicação descritos em
  `docs/RELEASE.md` quando o certificado do distribuidor estiver disponível.
