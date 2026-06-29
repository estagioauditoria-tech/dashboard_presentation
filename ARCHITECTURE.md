# Dashboard Editor — Arquitetura e Roadmap

## 1. Estado Atual (Junho 2026)

### Stack
- `index.html`, `style.css`, `app.js` — 3 arquivos, ~1.750 linhas de JS
- Vanilla JS, sem framework, sem build step
- CDN: Chart.js 4.4.1, pdfmake 0.2.7

### Estrutura de `app.js`

| Seção | Responsabilidade |
|---|---|
| Estado global | `dashboardData`, `editMode`, `viewMode`, `dataSnapshot`, constantes |
| Parser | `parseTXT` — lê .txt e popula `dashboardData` |
| Serializador | `exportTXT` — reconstrói .txt a partir de `dashboardData` |
| Cálculos | `calcKPI`, `collectChartData`, `getCardStats`, `getAllItens` |
| Renderização | `renderDashboard`, Chart.js, `buildKPI`, `destroyCharts` |
| Modal | Sistema de modal de revisão de edições |
| Popovers / helpers | `showPopover`, `inlineEdit`, `buildPopoverOptions` |
| Handlers de edição | Todas as funções `edit*`, color picker, `openCreateTipoPopover` |
| Event delegation | `handleGridClick`, `handleKpiClick`, `handleHeaderClick` |
| Modos | `enterEditMode`, `exitEditMode`, `discardEdits`, `updateModeUI` |
| Inicialização | `importFile`, `createFromScratch`, `downloadTemplate` |
| PDF export | `exportPDF`, `_pdfChartImg`, `_pdfKpiBlock`, `_pdfCardBlock` |
| Tema | `toggleTheme`, `isDark` |

---

## 2. Análise de Modularidade

### Diagnóstico

O arquivo está no limiar de conforto (~1.750 linhas). As seções já estão conceitualmente separadas pelas banners `/* ══ */`, mas o acoplamento é alto:

- Praticamente toda função acessa `dashboardData`, `editMode`, `viewMode` como globais
- O HTML usa `onclick="..."` inline, vinculando ao escopo global — incompatível com ES modules sem adaptação
- Não há testes automatizados, tornando qualquer refactor de maior escala mais arriscado

**Gatilho recomendado para migração:**
- `app.js` ultrapassar **2.000 linhas**, ou
- Início de qualquer feature de **persistência/sincronização**, ou
- **Mais de um desenvolvedor** ativo no projeto

### Proposta de módulos ES

```
state.js      → dashboardData, editMode, viewMode, dataSnapshot — estado compartilhado
parser.js     → parseTXT, exportTXT
calc.js       → calcKPI, calcSubKPI, collectChartData, getCardStats, getAllItens
render.js     → renderDashboard, renderChart, buildKPI, destroyCharts
editor.js     → showPopover, inlineEdit, handlers edit*, colorPicker, openCreateTipoPopover
export.js     → exportPDF + helpers _pdf*, downloadEditedTXT, downloadTemplate
app.js        → orquestra imports, registra event listeners, init
```

**O que muda no HTML:** todos os `onclick="..."` inline viram event listeners em `app.js`. O `<script src="app.js">` troca para `<script type="module" src="app.js">`.

---

## 3. Levantamento de Requisitos Futuros

### Alta prioridade

| # | Requisito | Motivação |
|---|---|---|
| R1 | **Persistência local** (`localStorage`) | Evitar perda de dados ao fechar a aba sem exportar TXT |
| R2 | **Histórico de versões / undo** | Edições destrutivas sem possibilidade de reverter passo a passo |
| R3 | **Layout responsivo / mobile** | Layout atual quebra em telas menores que 900px |

### Média prioridade

| # | Requisito | Motivação |
|---|---|---|
| R4 | **Biblioteca de templates** | Curva de aprendizado do formato TXT é alta para novos usuários |
| R5 | **Exportação para PNG** | Alternativa ao PDF para uso em apresentações e slides |
| R6 | **Filtros interativos** no modo visualização | Isolar estados ou cards sem entrar em modo edição |
| R7 | **Modo apresentação** (fullscreen, navegação por card) | Uso em reuniões sem o ruído da UI de edição |
| R8 | **Compartilhamento via URL** | Hash com dados comprimidos (LZ-string) — zero infraestrutura adicional |

### Baixa prioridade / exploratório

| # | Requisito | Motivação |
|---|---|---|
| R9 | Mais tipos de gráfico (gauge, área) | Casos de uso específicos de séries temporais |
| R10 | Anotações por item com histórico | Rastreabilidade de mudanças ao longo do tempo |
| R11 | Multi-arquivo / workspace | Gerenciar múltiplos dashboards no mesmo contexto |
| R12 | i18n | Uso em contextos multilíngues |

### Não-funcionais

| # | Requisito | Critério de aceitação |
|---|---|---|
| NF1 | Performance com 50+ cards | Renderização inicial < 500ms |
| NF2 | Acessibilidade | WCAG 2.1 AA — navegação por teclado, ARIA em popovers e modais |
| NF3 | Testes automatizados | Cobertura de parser, serializer e cálculos de KPI (funções puras, sem DOM) |

---

## 4. Design Arquitetural (pós-modularização)

### Padrão de estado

Um módulo `state.js` exporta um único objeto mutável compartilhado. Sem reatividade automática — render é chamado explicitamente após mutações:

```javascript
// state.js
export const store = {
  data: null,       // dashboardData
  editMode: false,
  viewMode: false,
  snapshot: null    // cópia para rollback
};
```

### Camada de persistência (R1)

```javascript
// storage.js (futuro)
export function save(data) {
  localStorage.setItem('dashboard_v1', exportTXT(data));
}
export function load() {
  const txt = localStorage.getItem('dashboard_v1');
  return txt ? parseTXT(txt) : null;
}
```

Ponto de integração: `confirmEdits()` chama `save()` ao confirmar edições; `init()` chama `load()` na inicialização.

### Estratégia de testes (NF3)

Parser e serializer são funções puras — testáveis com qualquer test runner (Vitest, Jest) sem DOM. Cálculos de KPI também são puros. Renderização e edição exigem jsdom ou Playwright.

```
tests/
  parser.test.js     → parseTXT, exportTXT (round-trip)
  calc.test.js       → calcKPI, collectChartData
  render.test.js     → renderDashboard (jsdom)
```

### Compartilhamento via URL (R8)

```javascript
// share.js (futuro)
import { compress, decompress } from 'lz-string'; // CDN

export function toShareURL(data) {
  return location.origin + location.pathname + '#' + compress(exportTXT(data));
}
export function fromShareURL() {
  const hash = location.hash.slice(1);
  return hash ? parseTXT(decompress(hash)) : null;
}
```

Zero infraestrutura: o TXT comprimido cabe no hash da URL para dashboards de tamanho moderado (~50 itens ≈ 2–3KB comprimido).

---

*Criado em Junho 2026. Revisar a cada milestone relevante.*
