# Constituicao do Projeto - CODEX APP

## Regra Suprema

O Codex / IA deve seguir todas as regras do projeto rigorosamente e sem excecao.

Nenhuma implementacao, otimizacao, abstracao, refatoracao, dependencia, atalho
ou decisao arquitetural pode violar as regras definidas neste documento.

Quando existir conflito, a ordem de prioridade deve ser sempre:

1. Regras do projeto
2. Integridade da arquitetura
3. Manutenibilidade
4. Previsibilidade
5. Seguranca
6. Performance
7. Velocidade de desenvolvimento

Velocidade nunca justifica degradacao arquitetural.

---

# Filosofia Central

O projeto deve permanecer:

* Limpo
* Previsivel
* Minimalista
* Modular
* Explicito
* Facil de manter
* Escalavel
* Pronto para producao

A base do codigo deve evoluir continuamente em direcao a simplicidade, nunca a
complexidade.

Toda implementacao deve resolver problemas reais usando a menor complexidade
necessaria.

Evitar:

* Overengineering
* Abstracoes prematuras
* Solucoes temporarias
* Comportamentos ocultos
* Fluxos implicitos
* Caos defensivo
* Inconsistencia arquitetural

O sistema deve continuar compreensivel meses depois sem depender de contexto
historico.

---

# Regras do Repositorio

* Manter um repositorio Git local desde o inicio.
* Comitar toda mudanca logica concluida.
* Mensagens de commit devem:

  * estar em ingles
  * ser curtas
  * usar verbo no imperativo
  * descrever claramente mudancas reais
* Manter `docs/TODO.md` minimalista, atualizado e acionavel.
* Nunca versionar segredos, credenciais, tokens ou dados privados.
* Evitar arquivos, dependencias, assets, logs ou ferramentas sem necessidade
  real.
* Preferir uma base limpa e funcional ao inves de preservar compatibilidade
  obsoleta.
* Evitar acumular divida tecnica intencionalmente.

---

# Stack Oficial

* Rust 2024 Edition e toolchain estavel atual.
* Tauri 2 para shell desktop nativo.
* TypeScript estrito no frontend.
* Vite como empacotador frontend.
* Windows e o alvo operacional inicial.
* O `NativeEngine` deste projeto e o dono da composicao do agente.
* OAuth ChatGPT, provider, ferramentas, configuracao e persistencia pertencem ao
  backend Rust nativo deste projeto.
* O Codex CLI aberto pode ser consultado somente como referencia de protocolo;
  nunca pode ser dependencia de build, runtime, armazenamento ou configuracao.
* Credenciais pertencem ao diretorio e ao cofre privados deste aplicativo;
  nunca devem ser importadas da CLI, copiadas, expostas ou reinterpretadas pela
  interface.
* Nao criar adaptadores, aliases ou caminhos de retrocompatibilidade para a CLI,
  protocolos, contratos ou formatos externos obsoletos.
* Migracoes internas do schema e dos dados persistidos pelo proprio aplicativo
  sao permitidas quando necessarias para preservar dados existentes ou evoluir o
  produto. Toda migracao interna deve:
  * possuir versao explicita e escopo delimitado;
  * validar a identidade e o schema do banco antes de executar;
  * ser atomica e transacional, sem deixar estado parcial em caso de falha;
  * preservar a integridade dos dados ou interromper a operacao de forma visivel;
  * possuir testes de sucesso, falha e integridade dos dados;
  * permanecer restrita ao dominio interno, sem importar formatos externos ou
    criar uma camada geral de compatibilidade.

Qualquer tecnologia nova deve ter motivo claro, escopo isolado e custo de
manutencao proporcional ao beneficio.

---

# Regras de Arquitetura

## Estrutura

* Organizar sistemas em modulos pequenos e coesos.
* Cada modulo deve possuir responsabilidade clara.
* Preferir composicao ao inves de heranca.
* Preferir contratos explicitos ao inves de comportamento implicito.
* Preferir fluxos deterministicos ao inves de magica dinamica.
* Preferir abstracoes simples ao inves de camadas profundas de abstracao.
* Evitar objetos gigantes e acumulo centralizado de logica.
* Regras de negocio nao devem se espalhar de forma imprevisivel.

## Design

* APIs devem permanecer pequenas e explicitas.
* Entradas, saidas, efeitos colaterais e falhas devem ser sempre visiveis.
* Nenhum fallback silencioso.
* Nenhum caminho oculto de recuperacao de inicializacao.
* Nenhuma falsa resiliencia escondendo falhas reais.
* Erros devem aparecer de forma clara e previsivel.
* Transicoes de estado devem ser rastreaveis.

## Evolucao

* Sistemas devem ser preparados para expansao futura sem reescritas
  destrutivas.
* Refatoracoes devem simplificar o projeto, nao reorganizar complexidade.
* Reduzir fragmentacao sempre que possivel.
* Remover continuamente codigo morto, obsoleto ou duplicado.

---

# Regras de Codigo

## Rust

* Usar Rust estavel moderno com `edition = "2024"`.
* Ativar tipagem forte, ownership explicito e erros estruturados.
* Evitar `unsafe`; quando inevitavel, isolar em modulo pequeno, documentar
  invariantes e validar em runtime.
* Preferir tipos de dominio a strings soltas quando houver regra semantica.
* Usar `Result` para falhas recuperaveis; nenhum erro operacional deve ser
  escondido.
* Evitar `panic!`, `unwrap` e `expect` fora da inicializacao irrecuperavel.
* Modulos e arquivos Rust devem seguir convencoes idiomaticas da linguagem.

## TypeScript

* Usar TypeScript estrito.
* Manter tipos de fronteira sincronizados com os contratos expostos pelo Rust.
* Evitar estado global mutavel sem dono claro.
* UI deve chamar comandos Tauri pequenos, explicitos e rastreaveis.

## Nomeacao

* Usar nomes claros e descritivos.
* Evitar abreviacoes, salvo quando universalmente conhecidas.
* Evitar prefixos e sufixos artificiais.
* Respeitar a convencao nativa de cada linguagem e ferramenta.
* Snake case e kebab case sao permitidos quando forem convencoes do ecossistema.

## Logica

Aplicar:

* Single Responsibility Principle
* DRY
* Ownership explicito
* Gerenciamento explicito de lifetime

Evitar:

* Numeros magicos
* Codigo morto
* Codigo comentado obsoleto
* Mutacao oculta de estado
* Ownership implicito
* Manipulacao insegura de recursos

Constantes devem sempre possuir:

* significado semantico
* tipo explicito
* clareza contextual

---

# Regras de Runtime e Confiabilidade

* Validacao em runtime e a principal fonte de confianca.
* Preferir validacao live ao inves de excesso de testes automatizados.
* Criar testes apenas quando entregarem valor real e mensuravel.
* Evitar testes barulhentos, redundantes ou caros de manter.
* Logs devem existir apenas quando operacionalmente uteis.
* Evitar poluicao de debug.

O sistema deve validar continuamente:

* seguranca de memoria
* lifetime de recursos
* correcao de ownership
* ordem de inicializacao
* visibilidade de falhas

Operacoes que alteram configuracoes ou arquivos devem ser explicitas, reversiveis
quando possivel e precedidas por validacao de alvo.

---

# Regras de Performance

* Otimizar com responsabilidade.
* Nunca sacrificar manutencao por micro-otimizacoes.
* Evitar alocacoes desnecessarias.
* Evitar overhead desnecessario em runtime.
* Priorizar performance estavel e previsivel.
* Medir antes de otimizar agressivamente.

Performance deve ser intencional, nunca acidental.

---

# Regras de Dependencias

* Toda dependencia deve justificar sua existencia.
* Preferir solucoes internas quando a complexidade for baixa.
* Evitar excesso de dependencias.
* Manter integracoes externas isoladas.
* Atualizar dependencias regularmente para versoes modernas e seguras.

---

# Regras de UI e UX

* Interfaces devem permanecer limpas, diretas e funcionais.
* Nenhuma complexidade visual sem valor pratico.
* Evitar estados, opcoes ou controles sem utilidade real.
* Menus e fluxos devem minimizar atrito.
* A densidade de informacao deve permanecer organizada e intencional.

---

# Regras Operacionais da IA

A IA deve:

* Pensar antes de implementar.
* Preservar consistencia arquitetural.
* Detectar riscos futuros de manutencao.
* Alertar violacoes arquiteturais antes de prosseguir.
* Evitar implementacoes especulativas.
* Nunca inventar APIs, sistemas ou comportamentos inexistentes.
* Evitar solucoes parciais e inacabadas.
* Preferir implementacoes completas e funcionais.

Antes de finalizar qualquer mudanca, sempre revisar:

* duplicacao
* codigo morto
* ambiguidade
* ownership inseguro
* impacto de manutencao
* consistencia arquitetural

---

# Padroes Proibidos

Evitar explicitamente:

* Abuso de Singleton
* Abuso de Service Locator
* Globais ocultos
* Dependencias circulares
* Arvores profundas de heranca
* Mutacao de estado sem ownership claro
* God Classes
* Abuso de reflection em runtime
* Ownership implicito de recursos

---

# Regras de Decisao de Engenharia

Quando multiplas solucoes existirem, preferir sempre a que:

1. Reduz manutencao futura
2. Melhora previsibilidade
3. Reduz complexidade oculta
4. Minimiza acoplamento
5. Facilita debugging
6. Possui menos partes moveis
7. Preserva consistencia arquitetural

---

# Diretiva Final

Todas as futuras instrucoes devem ser interpretadas atraves desta constituicao.

Caso uma solicitacao entre em conflito com estas regras, o conflito deve ser
explicitamente informado antes da implementacao continuar.

A integridade de longo prazo do projeto e obrigatoria e inegociavel.
