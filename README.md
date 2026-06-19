# Dashboard Presentation

Gerador de dashboards a partir de arquivos TXT estruturados. Pagina HTML pura (sem framework, sem build) que le um arquivo de texto, renderiza cards, graficos e indicadores — e permite edicao visual completa.

## Como usar

1. Abra `index.html` no navegador
2. Clique em **Baixar template** para ver o formato esperado do TXT
3. Edite o TXT com seus dados
4. Clique em **Importar dados** para gerar o dashboard
5. Clique em **Editar** para entrar no modo de edicao visual
6. Ao finalizar, baixe o TXT atualizado ou descarte as alteracoes

## Formato do TXT

O arquivo define tipos de dados, indicadores, cards e graficos:

```
TITULO: Marca | Titulo | Subtitulo

TIPO tarefa = enum(concluido: #1D9E75, pendente: #94A3B8)
TIPO producao = numero(ton)

CABECALHO
  Total | contagem: *
  Concluidos | incluir: Total | contagem: * | filtro: concluido
  Producao media | media: Producao Anual | sub: ton/ano
  Progresso | porcentagem: contagem: * filtro: concluido / contagem: *

CARD Nome | cor: #1D9E75
  GRUPO Nome do Grupo
    tarefa: Item exemplo = concluido
    tarefa: Outro item = pendente | nota: observacao
  GRAFICO pizza | dados: Nome do Grupo
```

### Tipos (TIPO)

- **enum** — estados categoricos com cor (ex: concluido, pendente, em andamento)
- **numero** — valores numericos com unidade livre (ton, R$, %, km)

### Funcoes do cabecalho

| Funcao | Descricao |
|--------|-----------|
| `contagem` | Conta itens. Use `filtro:` para um estado especifico |
| `soma` | Soma valores numericos |
| `media` | Media dos valores |
| `maximo` | Maior valor |
| `minimo` | Menor valor |
| `porcentagem` | Razao numerador / denominador. Ex: `porcentagem: contagem: * filtro: feito / contagem: *` |

### Parametros extras do cabecalho

| Parametro | Descricao |
|-----------|-----------|
| `filtro:` | Filtra itens por estado antes de aplicar a funcao |
| `sub:` | Texto descritivo exibido abaixo do valor |
| `incluir:` | Agrupa este indicador dentro de outro card do cabecalho (referencia pelo label) |

### Tipos de grafico

- `pizza` — ideal para enums
- `barras` — ideal para numeros
- `linhas` — ideal para series

## Modo de edicao

Apos importar um TXT, clique em **Editar** para modificar o dashboard visualmente:

- **Status** — clique no icone para escolher outro estado
- **Nomes, valores, notas** — clique para editar inline
- **Indicadores (KPIs)** — edite labels, configure funcoes, adicione ou remova
- **Cards, grupos, itens** — adicione ou remova com os botoes [+] e [x]
- **Graficos** — altere tipo (pizza/barras/linhas) e selecione grupos de dados
- **Titulos** — clique na marca, titulo ou subtitulo do header

Ao finalizar, revise o TXT gerado, baixe ou descarte.

## Exportar PDF

Clique em **Exportar PDF** para imprimir o dashboard via dialogo do navegador (salve como PDF).

## Estrutura

```
index.html    — pagina principal
style.css     — estilos
app.js        — parser, renderizacao, edicao e serializacao
```

Dependencia externa: [Chart.js](https://www.chartjs.org/) via CDN.
