# Regras do projeto

Este documento é o contrato máximo do repositório. Nenhuma implementação,
refatoração, dependência ou atalho pode contrariá-lo.

Em caso de conflito, priorize: regras do projeto, integridade arquitetural,
manutenção, previsibilidade, segurança, desempenho e, por último, velocidade de
entrega. Informe o conflito antes de continuar.

## Princípios

- Resolva a causa, nunca apenas o sintoma.
- Use a menor complexidade capaz de resolver o problema completo.
- Prefira código explícito, coeso, previsível, modular e pronto para produção.
- Prefira composição, contratos pequenos e fluxos determinísticos.
- Evite abstrações prematuras, camadas profundas, estado oculto e fallbacks
  silenciosos.
- Remova código morto, duplicado, obsoleto e compatibilidade sem uso real.
- Uma refatoração deve reduzir complexidade total, não apenas movê-la.
- Entradas, saídas, efeitos, ownership, transições e falhas devem ser visíveis.

## Produto e stack

- O alvo operacional é Windows, com Tauri 2, Rust edition 2024, TypeScript
  estrito e Vite.
- A toolchain Rust é a versão estável fixada em `rust-toolchain.toml`.
- `NativeEngine` é o dono da composição do agente.
- OAuth ChatGPT, provider, ferramentas, configuração, secrets e persistência
  pertencem ao backend Rust deste aplicativo.
- O Codex CLI pode ser estudado como referência, mas nunca pode ser dependência
  de build, runtime, configuração, armazenamento ou credenciais.
- A interface nunca deve receber tokens ou reinterpretar credenciais.
- Não crie aliases, adaptadores ou caminhos gerais para formatos externos ou
  protocolos obsoletos.
- Toda tecnologia nova precisa de benefício comprovado, fronteira isolada e
  custo de manutenção proporcional.

## Arquitetura

- Organize o sistema em módulos pequenos, coesos e com um dono claro.
- Mantenha regras de negócio no domínio responsável, sem duplicá-las entre
  backend, infraestrutura e UI.
- Use tipos de domínio para estados e valores com semântica própria.
- APIs devem ser mínimas; não exponha detalhes internos por conveniência.
- Estado global mutável exige ownership explícito e justificativa.
- Recursos concorrentes precisam de lifecycle, cancelamento e encerramento
  definidos.
- Erros operacionais devem ser estruturados, observáveis e previsíveis.
- Não esconda falhas de inicialização nem simule resiliência com recuperação
  implícita.

Migrações internas são permitidas apenas para dados deste aplicativo. Cada
migração deve ter versão e escopo explícitos, validar identidade e schema,
executar atomicamente, preservar dados ou falhar de forma visível e possuir
testes de sucesso, falha e integridade. Nunca importe formatos da CLI por essa
via.

## Rust

- Use Rust idiomático, ownership explícito e erros estruturados.
- Use `Result` para falhas recuperáveis; não descarte erros operacionais.
- Evite `panic!`, `unwrap` e `expect` fora de inicialização comprovadamente
  irrecuperável.
- Evite `unsafe`. Quando inevitável, isole-o, documente as invariantes e valide
  as pré-condições.
- Prefira enums, newtypes e estruturas validadas a strings ou mapas soltos.
- Recursos do sistema operacional devem ser liberados de forma determinística.

## TypeScript e interface

- Mantenha `strict` ativo e não contorne o compilador com tipos amplos.
- Decodifique toda resposta e evento Tauri antes de alterar estado.
- Mantenha os contratos TypeScript sincronizados com os contratos Rust.
- Componentes de UI não acessam IPC diretamente; infraestrutura e estado são as
  fronteiras responsáveis.
- A interface deve ser limpa, direta, acessível e sem controles sem função.
- Estados de carregamento, erro, vazio, aprovação e cancelamento devem ser
  explícitos.
- Densidade visual e animação precisam de utilidade prática e comportamento
  estável.

## Código

- Use nomes descritivos e as convenções nativas de cada linguagem.
- Evite abreviações não universais, números mágicos e comentários obsoletos.
- Constantes precisam de nome semântico, tipo adequado e contexto claro.
- Aplique responsabilidade única e elimine duplicação real; não force DRY entre
  conceitos apenas parecidos.
- Não use God Classes, Service Locator, globais ocultos, ciclos, herança
  profunda, reflection indiscriminada ou ownership implícito.
- Logs devem ser úteis para operação, estruturados quando necessário e nunca
  conter dados privados.

## Segurança e persistência

- Nunca versione secrets, credenciais, tokens ou dados privados.
- Secrets ficam no cofre e no diretório privado deste aplicativo.
- SQLite armazena apenas dados adequados ao seu domínio, com transações nas
  alterações compostas.
- Valide tamanho, formato, identidade e destino de toda entrada externa.
- Alterações de arquivo ou configuração devem ter alvo validado, efeito
  explícito e ser reversíveis quando possível.
- Permissões são fechadas por padrão e não podem ser ampliadas implicitamente.
- Limites de memória, saída, arquivos, processos, streams e concorrência devem
  ser explícitos e testados.

## Testes e validação

- Valide em runtime todas as fronteiras externas e invariantes que dependem do
  ambiente.
- Cada defeito corrigido deve receber um teste de regressão focado no contrato
  violado.
- Teste caminhos de sucesso, erro, cancelamento e concorrência quando forem
  relevantes.
- Evite testes duplicados, frágeis ou sem valor observável.
- `pnpm verify` é o gate completo antes de concluir ou publicar mudanças.
- Não enfraqueça lint, tipagem, Clippy, testes ou medições para fazer o gate
  passar.

## Desempenho

- Meça antes e depois de otimizações relevantes com cenário reproduzível.
- Proteja regressões críticas com limites ou benchmarks estáveis.
- Prefira latência e uso de memória previsíveis a micro-otimizações complexas.
- Evite cópias, alocações, serializações e trabalho no thread principal sem
  necessidade.
- Uma otimização não pode degradar clareza, correção ou manutenção sem benefício
  mensurável e documentado.

## Dependências

- Cada dependência direta deve justificar seu custo e permanecer fixada no
  manifesto e no lockfile.
- Prefira implementação local quando ela for pequena, segura e mais simples de
  manter.
- Isole integrações externas e atualize dependências regularmente.
- Exceções transitivas precisam de justificativa, versão exata e gate de
  regressão.
- Não mantenha assets, ferramentas ou pacotes sem uso real.

## Git e documentação

- Preserve mudanças do usuário e não reescreva histórico sem autorização.
- Faça um commit para cada mudança lógica concluída.
- Mensagens de commit são curtas, em inglês, no imperativo e descrevem a mudança
  real.
- Mantenha `docs/TODO.md` curto, atual e acionável.
- Documente contratos e decisões duráveis; detalhes que o código expressa com
  mais precisão pertencem ao código e aos testes.
- Atualize números medidos, versões e capacidades junto com a mudança que os
  altera. Não acumule cronologias em documentos de estado atual.

## Processo de mudança

Antes de implementar:

1. leia estas regras e identifique o dono do comportamento;
2. confirme o estado real no código, nos testes e nos manifestos;
3. escolha a solução com menos acoplamento e partes móveis.

Antes de concluir:

1. revise duplicação, código morto, ambiguidades, ownership e falhas;
2. adicione a cobertura de regressão necessária;
3. atualize documentação e TODO afetados;
4. execute `pnpm verify` e revise o diff completo.

Não invente APIs ou comportamentos, não entregue soluções parciais e não troque
integridade de longo prazo por velocidade.
