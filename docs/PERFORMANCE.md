# Baseline de desempenho

O baseline deve ser coletado no executável `release`, com a conta já autenticada
e o projeto deste repositório selecionado. Ele é evidência para decisões de
otimização, não um benchmark sintético de CI.

## Inicialização e memória

Após `pnpm tauri build --no-bundle`, execute:

```powershell
pwsh -File scripts/measure-release.ps1
```

O script abre exatamente o executável informado, mede o tempo até uma janela
responsiva, aguarda três segundos, registra `WorkingSet` e memória privada e
fecha a mesma instância pela mensagem normal da janela. Nenhum processo é
encerrado à força.

## Latência de stream

A latência é medida ao vivo entre a ação de enviar uma mensagem curta e o
primeiro delta visível do mesmo turno. Use um projeto já materializado, sem
anexos, registre modelo, esforço, tier, rede e três amostras. Não compare
modelos ou condições de rede diferentes como se fossem a mesma série.

## Resultado atual

Coleta local de 2 de agosto de 2026, Windows `10.0.26200.0`, 28 processadores
lógicos, conta autenticada e este repositório selecionado:

| Amostra | Janela responsiva | Working set | Memória privada |
| ---: | ---: | ---: | ---: |
| 1, processo frio | 955,9 ms | 42,0 MiB | 8,9 MiB |
| 2 | 87,1 ms | 36,3 MiB | 8,9 MiB |
| 3 | 77,2 ms | 36,3 MiB | 9,0 MiB |

O executável mede 10,7 MiB. A mediana de inicialização foi 87,1 ms, o working
set médio 38,2 MiB e a memória privada média 8,9 MiB. A primeira amostra inclui
o carregamento frio do WebView e deve permanecer visível, sem ser descartada
para melhorar artificialmente o resultado.

A latência do primeiro delta continua exigindo um turno real controlado. A
tentativa autorizada de 2 de agosto de 2026 atravessou a normalização local do
histórico, mas o provider recusou o início do stream com `HTTP 429` e
`usage_limit_reached`. A medição e a aprovação ao vivo devem ser retomadas
somente após a renovação da cota; a duração total e uma resposta de erro não são
substitutos válidos para essa amostra.
