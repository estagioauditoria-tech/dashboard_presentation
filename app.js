/* ── Estado global ── */
let dashboardData = null;
let editMode = false;
let viewMode = false;
let dataSnapshot = null;

const TIPOS_GRAFICO = [
  { value: 'pizza',  label: 'Pizza',  desc: 'Ideal para dados categoricos (enum)' },
  { value: 'barras', label: 'Barras', desc: 'Ideal para valores numericos' },
  { value: 'linhas', label: 'Linhas', desc: 'Ideal para series temporais/evolucao' }
];

/* ══════════════════════════════════════════
   PARSER
   ══════════════════════════════════════════ */

function parseTXT(text) {
  const lines = text.split(/\r?\n/);
  const data = { titulo: '', marca: '', subtitulo: '', tipos: {}, cabecalho: [], cards: [] };
  let currentCard = null;
  let currentGroup = null;
  let inCabecalho = false;

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line === 'CABECALHO') {
      inCabecalho = true;
      currentCard = null;
      currentGroup = null;
      continue;
    }

    if (line.startsWith('TITULO:') || line.startsWith('RAIZ ') || line.startsWith('TIPO ') || line.startsWith('CARD ')) {
      inCabecalho = false;
    }

    if (inCabecalho) {
      const kpi = parseCabecalhoLine(line);
      if (kpi) data.cabecalho.push(kpi);
      continue;
    }

    if (line.startsWith('TITULO:')) {
      const parts = line.slice(7).split('|').map(s => s.trim());
      data.marca = parts[0] || '';
      data.titulo = parts[1] || '';
      data.subtitulo = parts[2] || '';
      continue;
    }

    if (line.startsWith('RAIZ ') || line.startsWith('TIPO ')) {
      const match = line.match(/^(?:RAIZ|TIPO)\s+(\S+)\s*=\s*(enum|numero)\((.+)\)$/);
      if (!match) continue;
      const [, name, type, body] = match;
      if (type === 'enum') {
        const estados = body.split(',').map(s => s.trim()).map(s => {
          const m = s.match(/^(.+):\s*(#[0-9A-Fa-f]{3,8})$/);
          if (!m) return null;
          return { nome: m[1].trim(), cor: m[2] };
        }).filter(Boolean);
        data.tipos[name] = { tipo: 'enum', estados };
      } else {
        data.tipos[name] = { tipo: 'numero', unidade: body.trim() };
      }
      continue;
    }

    if (line.startsWith('CARD ')) {
      const parts = line.slice(5).split('|').map(s => s.trim());
      const nome = parts[0];
      let cor = '#94A3B8';
      for (let i = 1; i < parts.length; i++) {
        if (parts[i].startsWith('cor:')) cor = parts[i].slice(4).trim();
      }
      currentCard = { nome, cor, grupos: [], graficos: [] };
      currentGroup = null;
      data.cards.push(currentCard);
      continue;
    }

    if (line.startsWith('GRUPO ') && currentCard) {
      const nome = line.slice(6).trim();
      currentGroup = { nome, itens: [] };
      currentCard.grupos.push(currentGroup);
      continue;
    }

    if (line.startsWith('GRAFICO ') && currentCard) {
      const parts = line.slice(8).split('|').map(s => s.trim());
      const tipo = parts[0];
      let gruposRef = [];
      for (let i = 1; i < parts.length; i++) {
        if (parts[i].startsWith('dados:')) {
          gruposRef = parts[i].slice(6).split(',').map(s => s.trim());
        }
      }
      currentCard.graficos.push({ tipo, gruposRef });
      continue;
    }

    if (currentGroup && line.includes(':') && line.includes('=')) {
      const colonIdx = line.indexOf(':');
      const tipoRef = line.slice(0, colonIdx).trim();
      const rest = line.slice(colonIdx + 1).trim();
      const segments = rest.split('|').map(s => s.trim());
      const mainPart = segments[0];
      const eqIdx = mainPart.lastIndexOf('=');
      if (eqIdx === -1) continue;
      const nome = mainPart.slice(0, eqIdx).trim();
      const valor = mainPart.slice(eqIdx + 1).trim();
      let nota = '';
      for (let i = 1; i < segments.length; i++) {
        if (segments[i].startsWith('nota:')) nota = segments[i].slice(5).trim();
      }
      currentGroup.itens.push({ tipo: tipoRef, nome, valor, nota });
      continue;
    }
  }

  return data;
}

function parseCabecalhoLine(line) {
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 2) return null;
  const label = parts[0];
  let funcao = '', fonte = '', filtro = '', sub = '', incluir = '';
  let numerador = null, denominador = null;

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith('filtro:')) { filtro = p.slice(7).trim(); continue; }
    if (p.startsWith('sub:')) { sub = p.slice(4).trim(); continue; }
    if (p.startsWith('incluir:')) { incluir = p.slice(8).trim(); continue; }
    const colonIdx = p.indexOf(':');
    if (colonIdx !== -1) {
      const key = p.slice(0, colonIdx).trim();
      const val = p.slice(colonIdx + 1).trim();
      if (key === 'porcentagem') {
        funcao = 'porcentagem';
        const slashIdx = val.indexOf('/');
        if (slashIdx !== -1) {
          numerador = parsePorcentagemPart(val.slice(0, slashIdx));
          denominador = parsePorcentagemPart(val.slice(slashIdx + 1));
        }
      } else if (['contagem', 'soma', 'media', 'maximo', 'minimo'].includes(key)) {
        funcao = key;
        fonte = val;
      }
    }
  }
  if (!funcao) return null;
  return { label, funcao, fonte, filtro, sub, incluir, numerador, denominador };
}

function parsePorcentagemPart(str) {
  str = str.trim();
  let filtro = '';
  const filtroMatch = str.match(/\bfiltro:\s*(\S+)/);
  if (filtroMatch) {
    filtro = filtroMatch[1];
    str = str.replace(filtroMatch[0], '').trim();
  }
  const colonIdx = str.indexOf(':');
  if (colonIdx === -1) return null;
  return { funcao: str.slice(0, colonIdx).trim(), fonte: str.slice(colonIdx + 1).trim(), filtro };
}

/* ══════════════════════════════════════════
   SERIALIZAÇÃO
   ══════════════════════════════════════════ */

function exportTXT(data) {
  const lines = [];
  lines.push('TITULO: ' + data.marca + ' | ' + data.titulo + ' | ' + data.subtitulo);
  lines.push('');

  for (const [name, raiz] of Object.entries(data.tipos)) {
    if (raiz.tipo === 'enum') {
      const estados = raiz.estados.map(e => e.nome + ': ' + e.cor).join(', ');
      lines.push('TIPO ' + name + ' = enum(' + estados + ')');
    } else {
      lines.push('TIPO ' + name + ' = numero(' + raiz.unidade + ')');
    }
  }
  lines.push('');

  if (data.cabecalho.length > 0) {
    lines.push('CABECALHO');
    for (const kpi of data.cabecalho) {
      let line = '  ' + kpi.label;
      if (kpi.incluir) line += ' | incluir: ' + kpi.incluir;
      if (kpi.funcao === 'porcentagem' && kpi.numerador && kpi.denominador) {
        let numStr = kpi.numerador.funcao + ': ' + kpi.numerador.fonte;
        if (kpi.numerador.filtro) numStr += ' filtro: ' + kpi.numerador.filtro;
        let denStr = kpi.denominador.funcao + ': ' + kpi.denominador.fonte;
        if (kpi.denominador.filtro) denStr += ' filtro: ' + kpi.denominador.filtro;
        line += ' | porcentagem: ' + numStr + ' / ' + denStr;
      } else {
        line += ' | ' + kpi.funcao + ': ' + kpi.fonte;
      }
      if (kpi.filtro) line += ' | filtro: ' + kpi.filtro;
      if (kpi.sub) line += ' | sub: ' + kpi.sub;
      lines.push(line);
    }
    lines.push('');
  }

  for (const card of data.cards) {
    lines.push('CARD ' + card.nome + ' | cor: ' + card.cor);
    for (const grupo of card.grupos) {
      lines.push('  GRUPO ' + grupo.nome);
      for (const item of grupo.itens) {
        let line = '    ' + item.tipo + ': ' + item.nome + ' = ' + item.valor;
        if (item.nota) line += ' | nota: ' + item.nota;
        lines.push(line);
      }
    }
    for (const grafico of card.graficos) {
      lines.push('  GRAFICO ' + grafico.tipo + ' | dados: ' + grafico.gruposRef.join(', '));
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/* ══════════════════════════════════════════
   CÁLCULOS
   ══════════════════════════════════════════ */

function getAllItens(data) {
  const itens = [];
  for (const card of data.cards)
    for (const grupo of card.grupos)
      for (const item of grupo.itens)
        itens.push({ ...item, grupo: grupo.nome, card: card.nome });
  return itens;
}

function getItensByFonte(data, fonte) {
  if (fonte === '*') return getAllItens(data);
  const result = [];
  for (const card of data.cards)
    for (const grupo of card.grupos)
      if (grupo.nome === fonte)
        for (const item of grupo.itens)
          result.push({ ...item, grupo: grupo.nome, card: card.nome });
  return result;
}

function calcSubKPI(sub, data) {
  if (!sub) return 0;
  const itens = getItensByFonte(data, sub.fonte);
  if (sub.funcao === 'contagem') {
    return sub.filtro ? itens.filter(i => i.valor === sub.filtro).length : itens.length;
  }
  const nums = itens.map(i => parseFloat(i.valor)).filter(n => !isNaN(n));
  if (nums.length === 0) return 0;
  if (sub.funcao === 'soma') return nums.reduce((a, b) => a + b, 0);
  if (sub.funcao === 'media') return +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2);
  if (sub.funcao === 'maximo') return Math.max(...nums);
  if (sub.funcao === 'minimo') return Math.min(...nums);
  return 0;
}

function calcKPI(kpi, data) {
  if (kpi.funcao === 'porcentagem') {
    const num = calcSubKPI(kpi.numerador, data);
    const den = calcSubKPI(kpi.denominador, data);
    if (den === 0) return '0%';
    return +((num / den) * 100).toFixed(1) + '%';
  }
  const itens = getItensByFonte(data, kpi.fonte);
  if (kpi.funcao === 'contagem') {
    return kpi.filtro ? itens.filter(i => i.valor === kpi.filtro).length : itens.length;
  }
  const nums = itens.map(i => parseFloat(i.valor)).filter(n => !isNaN(n));
  if (nums.length === 0) return 0;
  if (kpi.funcao === 'soma') return nums.reduce((a, b) => a + b, 0);
  if (kpi.funcao === 'media') return +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2);
  if (kpi.funcao === 'maximo') return Math.max(...nums);
  if (kpi.funcao === 'minimo') return Math.min(...nums);
  return 0;
}

function collectChartData(card, grafico, raizes) {
  const grupos = card.grupos.filter(g => grafico.gruposRef.includes(g.nome));
  const itens = grupos.flatMap(g => g.itens);

  if (grafico.tipo === 'pizza') {
    const contagem = {};
    const cores = {};
    for (const item of itens) {
      const raiz = raizes[item.tipo];
      if (!raiz || raiz.tipo !== 'enum') continue;
      if (!contagem[item.valor]) contagem[item.valor] = 0;
      contagem[item.valor]++;
      const estado = raiz.estados.find(e => e.nome === item.valor);
      if (estado) cores[item.valor] = estado.cor;
    }
    return { labels: Object.keys(contagem), values: Object.values(contagem), colors: Object.keys(contagem).map(k => cores[k] || '#94A3B8') };
  }

  if (grafico.tipo === 'linhas') {
    const allLabels = [...new Set(grupos.flatMap(g => g.itens.map(i => i.nome)))];
    const datasets = grupos.map((g, idx) => {
      const map = Object.fromEntries(g.itens.map(i => [i.nome, parseFloat(i.valor) ?? null]));
      return { label: g.nome, values: allLabels.map(l => l in map ? map[l] : null), color: COLOR_PRESETS[idx % COLOR_PRESETS.length] };
    });
    return { labels: allLabels, datasets };
  }

  if (grafico.tipo === 'barras') {
    const firstRaiz = itens[0] ? raizes[itens[0].tipo] : null;
    if (firstRaiz?.tipo === 'enum') {
      const contagem = {};
      const cores = {};
      for (const item of itens) {
        const raiz = raizes[item.tipo];
        if (!raiz || raiz.tipo !== 'enum') continue;
        if (!contagem[item.valor]) contagem[item.valor] = 0;
        contagem[item.valor]++;
        const estado = raiz.estados.find(e => e.nome === item.valor);
        if (estado) cores[item.valor] = estado.cor;
      }
      return { labels: Object.keys(contagem), values: Object.values(contagem), colors: Object.keys(contagem).map(k => cores[k] || '#94A3B8') };
    }
    const labels = [], values = [], colors = [];
    for (const item of itens) {
      labels.push(item.nome);
      values.push(parseFloat(item.valor) || 0);
      colors.push(card.cor);
    }
    return { labels, values, colors };
  }

  return { labels: [], values: [], colors: [] };
}

function getCardStats(card, raizes) {
  let total = 0;
  const contagem = {};
  const cores = {};
  for (const grupo of card.grupos) {
    for (const item of grupo.itens) {
      total++;
      const raiz = raizes[item.tipo];
      if (!raiz || raiz.tipo !== 'enum') continue;
      if (!contagem[item.valor]) contagem[item.valor] = 0;
      contagem[item.valor]++;
      const estado = raiz.estados.find(e => e.nome === item.valor);
      if (estado) cores[item.valor] = estado.cor;
    }
  }
  return { total, contagem, cores };
}

/* ══════════════════════════════════════════
   RENDERIZAÇÃO
   ══════════════════════════════════════════ */

const chartInstances = [];
const pendingChartTimeouts = [];

function destroyCharts() {
  for (const id of pendingChartTimeouts) clearTimeout(id);
  pendingChartTimeouts.length = 0;
  chartInstances.forEach(c => c.destroy());
  chartInstances.length = 0;
}

function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderDashboard(data) {
  destroyCharts();
  dashboardData = data;
  document.getElementById('empty-state').classList.add('hidden');
  const dash = document.getElementById('dashboard');
  dash.classList.remove('hidden');

  // Header
  const brandEl = document.getElementById('header-brand');
  const titleEl = document.getElementById('header-title');
  const subEl = document.getElementById('header-subtitle');
  if (editMode) {
    brandEl.innerHTML = '<span data-editable="marca">' + esc(data.marca) + '</span>';
    titleEl.innerHTML = '<span data-editable="titulo">' + esc(data.titulo) + '</span>';
    subEl.innerHTML = '<span data-editable="subtitulo">' + esc(data.subtitulo) + '</span>';
  } else {
    brandEl.textContent = data.marca;
    titleEl.textContent = data.titulo;
    subEl.textContent = data.subtitulo;
  }

  document.getElementById('btn-editar').classList.toggle('hidden', editMode || viewMode);
  document.getElementById('btn-baixar').classList.toggle('hidden', editMode || viewMode);
  document.getElementById('btn-pdf').classList.toggle('hidden', false);

  // KPIs — agrupar por incluir
  const kpiRow = document.getElementById('kpi-row');
  kpiRow.innerHTML = '';
  const childMap = {};
  for (let ki = 0; ki < data.cabecalho.length; ki++) {
    const kpi = data.cabecalho[ki];
    if (kpi.incluir) {
      if (!childMap[kpi.incluir]) childMap[kpi.incluir] = [];
      childMap[kpi.incluir].push({ kpi, idx: ki });
    }
  }
  for (let ki = 0; ki < data.cabecalho.length; ki++) {
    const kpi = data.cabecalho[ki];
    if (kpi.incluir) continue;
    const valor = calcKPI(kpi, data);
    const children = childMap[kpi.label] || [];
    const el = document.createElement('div');
    el.className = 'kpi' + (children.length > 0 ? ' kpi-expanded' : '');
    const rmKpi = editMode ? '<button class="edit-action-remove kpi-remove" data-action="remove-kpi" data-kpi-idx="' + ki + '">&times;</button>' : '';
    let html = rmKpi +
      '<div class="kpi-label" ' + (editMode ? 'data-editable="kpi-label" data-kpi-idx="' + ki + '"' : '') + '>' + esc(kpi.label) + '</div>' +
      '<div class="kpi-value" ' + (editMode ? 'data-editable="kpi-config" data-kpi-idx="' + ki + '"' : '') + '>' + valor + '</div>' +
      (kpi.sub ? '<div class="kpi-sub">' + esc(kpi.sub) + '</div>' : '');
    if (children.length > 0) {
      html += '<div class="kpi-children">';
      for (const ch of children) {
        const cv = calcKPI(ch.kpi, data);
        const rmChild = editMode ? '<button class="edit-action-remove" data-action="remove-kpi" data-kpi-idx="' + ch.idx + '">&times;</button>' : '';
        html += '<div class="kpi-child">' +
          '<span class="kpi-child-label" ' + (editMode ? 'data-editable="kpi-label" data-kpi-idx="' + ch.idx + '"' : '') + '>' + esc(ch.kpi.label) + '</span>' +
          '<span class="kpi-child-value" ' + (editMode ? 'data-editable="kpi-config" data-kpi-idx="' + ch.idx + '"' : '') + '>' + cv + '</span>' +
          rmChild + '</div>';
      }
      html += '</div>';
    }
    el.innerHTML = html;
    kpiRow.appendChild(el);
  }
  if (editMode) {
    const addKpiBtn = document.createElement('button');
    addKpiBtn.className = 'edit-action-add kpi-add';
    addKpiBtn.setAttribute('data-action', 'add-kpi');
    addKpiBtn.textContent = '+ Indicador';
    kpiRow.appendChild(addKpiBtn);
  }

  // Cards
  const grid = document.getElementById('attr-grid');
  grid.innerHTML = '';
  let canvasId = 0;

  for (let ci = 0; ci < data.cards.length; ci++) {
    const card = data.cards[ci];
    const stats = getCardStats(card, data.tipos);
    const el = document.createElement('div');
    el.className = 'attr-card';

    const rmCard = editMode ? ' <button class="edit-action-remove" data-action="remove-card" data-card-idx="' + ci + '" title="Remover card">&times;</button>' : '';
    const accentAttrs = editMode ? ' data-editable="card-color" data-card-idx="' + ci + '" title="Mudar cor"' : '';
    let headerHTML = '<div class="attr-header">' +
      '<div class="attr-name"><div class="attr-accent" style="background:' + card.cor + '"' + accentAttrs + '></div>' +
      '<span data-editable="card-name" data-card-idx="' + ci + '">' + esc(card.nome) + '</span>' + rmCard + '</div>' +
      '<div class="attr-stats"><div class="attr-count">' + stats.total + ' itens</div></div></div>';

    let bodyHTML = '<div class="attr-body">';

    // Graficos
    if (card.graficos.length > 0 || editMode) {
      bodyHTML += '<div class="chart-col">';
      for (let gri = 0; gri < card.graficos.length; gri++) {
        const grafico = card.graficos[gri];
        const cid = 'chart-' + (canvasId++);
        bodyHTML += '<div class="chart-wrap"><canvas id="' + cid + '"></canvas></div>';
        if (editMode) {
          bodyHTML += '<div class="chart-edit-actions">' +
            '<button class="edit-action-small" data-editable="chart-type" data-card-idx="' + ci + '" data-chart-idx="' + gri + '">' + grafico.tipo + '</button>' +
            '<button class="edit-action-small" data-editable="chart-data" data-card-idx="' + ci + '" data-chart-idx="' + gri + '">dados</button>' +
            '<button class="edit-action-remove" data-action="remove-chart" data-card-idx="' + ci + '" data-chart-idx="' + gri + '" title="Remover grafico">&times;</button>' +
            '</div>';
        }
        const chartData = collectChartData(card, grafico, data.tipos);
        bodyHTML += '<div class="chart-legend">';
        if (grafico.tipo === 'linhas') {
          for (const ds of chartData.datasets) {
            bodyHTML += '<div class="legend-row"><span style="display:flex;align-items:center;gap:4px"><span class="legend-dot" style="background:' + ds.color + '"></span>' + esc(ds.label) + '</span></div>';
          }
        } else {
          for (let i = 0; i < chartData.labels.length; i++) {
            const dotAttrs = editMode ? ' data-editable="legend-color" data-label="' + esc(chartData.labels[i]) + '" data-card-idx="' + ci + '" title="Mudar cor"' : '';
            bodyHTML += '<div class="legend-row"><span style="display:flex;align-items:center;gap:4px"><span class="legend-dot" style="background:' + chartData.colors[i] + '"' + dotAttrs + '></span>' + esc(chartData.labels[i]) + '</span><span style="font-weight:500">' + chartData.values[i] + '</span></div>';
          }
        }
        bodyHTML += '</div>';
        pendingChartTimeouts.push(setTimeout(() => renderChart(cid, grafico.tipo, chartData), 0));
      }
      if (editMode) {
        bodyHTML += '<button class="edit-action-add" data-action="add-chart" data-card-idx="' + ci + '">+ grafico</button>';
      }
      bodyHTML += '</div>';
    }

    // Itens
    bodyHTML += '<div class="items-col">';
    for (let gi = 0; gi < card.grupos.length; gi++) {
      const grupo = card.grupos[gi];
      const rmGroup = editMode ? ' <button class="edit-action-remove" data-action="remove-group" data-card-idx="' + ci + '" data-group-idx="' + gi + '" title="Remover grupo">&times;</button>' : '';
      bodyHTML += '<div class="group-header"><span data-editable="group-name" data-card-idx="' + ci + '" data-group-idx="' + gi + '">' + esc(grupo.nome) + '</span>' + rmGroup + '</div>';

      for (let ii = 0; ii < grupo.itens.length; ii++) {
        const item = grupo.itens[ii];
        const raiz = data.tipos[item.tipo];
        let statusIcon = '<svg width="7" height="7" viewBox="0 0 7 7" fill="none"><circle cx="3.5" cy="3.5" r="2" stroke="currentColor" stroke-width="1.5"/></svg>';
        let statusStyle = 'background:var(--pend-bg);color:var(--pend-text)';

        if (raiz?.tipo === 'enum') {
          const estado = raiz.estados.find(e => e.nome === item.valor);
          if (estado) {
            statusStyle = 'background:' + estado.cor + '20;color:' + estado.cor;
          }
        } else if (raiz?.tipo === 'numero') {
          statusStyle = 'background:var(--surface2);color:var(--text3)';
          statusIcon = '<svg width="7" height="7" viewBox="0 0 7 7"><line x1="2" y1="2.5" x2="5" y2="2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="2" y1="4.5" x2="5" y2="4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="2.5" y1="1.5" x2="2" y2="5.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="4.5" y1="1.5" x2="4" y2="5.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
        }

        const rmItem = editMode ? '<button class="edit-action-remove" data-action="remove-item" data-card-idx="' + ci + '" data-group-idx="' + gi + '" data-item-idx="' + ii + '" title="Remover">&times;</button>' : '';

        let noteHTML = '';
        if (item.nota) {
          noteHTML = '<span class="item-note" data-editable="note" data-card-idx="' + ci + '" data-group-idx="' + gi + '" data-item-idx="' + ii + '">' + esc(item.nota) + '</span>';
        } else if (editMode) {
          noteHTML = '<span class="item-note-add" data-editable="note" data-card-idx="' + ci + '" data-group-idx="' + gi + '" data-item-idx="' + ii + '">+ nota</span>';
        }

        let valueHTML = '';
        if (raiz?.tipo === 'numero') {
          valueHTML = '<span class="item-value" data-editable="value" data-card-idx="' + ci + '" data-group-idx="' + gi + '" data-item-idx="' + ii + '">' + esc(item.valor) + (raiz.unidade ? ' ' + esc(raiz.unidade) : '') + '</span>';
        }

        bodyHTML += '<div class="item-row">' +
          '<div class="item-status" style="' + statusStyle + '" data-editable="status" data-card-idx="' + ci + '" data-group-idx="' + gi + '" data-item-idx="' + ii + '">' + statusIcon + '</div>' +
          '<span class="item-name"><span data-editable="item-name" data-card-idx="' + ci + '" data-group-idx="' + gi + '" data-item-idx="' + ii + '">' + esc(item.nome) + '</span>' + valueHTML + noteHTML + '</span>' +
          rmItem + '</div>';
      }

      if (editMode) {
        bodyHTML += '<button class="edit-action-add" data-action="add-item" data-card-idx="' + ci + '" data-group-idx="' + gi + '">+ item</button>';
      }
    }

    if (editMode) {
      bodyHTML += '<button class="edit-action-add" data-action="add-group" data-card-idx="' + ci + '">+ grupo</button>';
    }
    bodyHTML += '</div></div>';

    el.innerHTML = headerHTML + bodyHTML;
    grid.appendChild(el);
  }

  if (editMode) {
    const addBtn = document.createElement('button');
    addBtn.className = 'edit-action-add edit-action-add-card';
    addBtn.setAttribute('data-action', 'add-card');
    addBtn.textContent = '+ Card';
    grid.appendChild(addBtn);
  }

  document.getElementById('footer-left').textContent = data.marca + ' — ' + data.titulo;
}

function buildKPI(label, value, sub) {
  const el = document.createElement('div');
  el.className = 'kpi';
  el.innerHTML = '<div class="kpi-label">' + esc(label) + '</div>' +
    '<div class="kpi-value">' + value + '</div>' +
    (sub ? '<div class="kpi-sub">' + esc(sub) + '</div>' : '');
  return el;
}

/* ══════════════════════════════════════════
   GRÁFICOS (Chart.js)
   ══════════════════════════════════════════ */

function renderChart(canvasId, tipo, chartData) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const dark = isDark();
  const textColor = dark ? '#94A3B8' : '#475569';
  const gridColor = dark ? '#475569' : '#E2E8F0';
  const pieBorder = dark ? '#1E293B' : '#FFFFFF';
  let config;

  if (tipo === 'pizza') {
    config = {
      type: 'pie',
      data: { labels: chartData.labels, datasets: [{ data: chartData.values, backgroundColor: chartData.colors, borderColor: pieBorder, borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx) { const total = ctx.dataset.data.reduce((a, b) => a + b, 0); return ' ' + ctx.label + ': ' + ctx.parsed + ' (' + ((ctx.parsed / total) * 100).toFixed(1) + '%)'; } } } }, animation: { animateRotate: true, duration: 800 } }
    };
  } else if (tipo === 'barras') {
    config = {
      type: 'bar',
      data: { labels: chartData.labels, datasets: [{ data: chartData.values, backgroundColor: chartData.colors, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: textColor, font: { size: 10 } }, grid: { display: false } }, y: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } } } }
    };
  } else if (tipo === 'linhas') {
    const multi = chartData.datasets.length > 1;
    config = {
      type: 'line',
      data: {
        labels: chartData.labels,
        datasets: chartData.datasets.map(ds => ({
          label: ds.label,
          data: ds.values,
          borderColor: ds.color,
          backgroundColor: ds.color + '20',
          fill: !multi,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: ds.color,
          spanGaps: true
        }))
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: multi, labels: { color: textColor, font: { size: 10 }, boxWidth: 10, padding: 8 } }
        },
        scales: {
          x: { ticks: { color: textColor, font: { size: 10 } }, grid: { display: false } },
          y: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } }
        }
      }
    };
  }

  if (config) chartInstances.push(new Chart(canvas, config));
}

/* ══════════════════════════════════════════
   MODAL
   ══════════════════════════════════════════ */

function openModal(title, bodyHTML, footerHTML) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHTML;
  document.getElementById('modal-footer').innerHTML = footerHTML;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

function openFinalizarModal() {
  const txt = exportTXT(dashboardData);
  const bodyHTML = '<textarea readonly class="modal-textarea">' + esc(txt) + '</textarea>';
  let footer = '';
  if (viewMode) footer += '<button class="btn btn-ghost" onclick="backToEdit()">Voltar a editar</button>';
  footer += '<button class="btn btn-danger" onclick="discardEdits()">Descartar</button>';
  footer += '<button class="btn" onclick="enterViewMode()">Visualizar</button>';
  footer += '<button class="btn" onclick="downloadEditedTXT()">Baixar TXT</button>';
  footer += '<button class="btn btn-primary" onclick="confirmEdits()">Confirmar edicoes</button>';
  openModal('Revisao do TXT', bodyHTML, footer);
}

function confirmEdits() {
  dataSnapshot = null;
  editMode = false;
  viewMode = false;
  updateModeUI();
  closeModal();
  renderDashboard(dashboardData);
}

/* ══════════════════════════════════════════
   HELPERS DE EDIÇÃO
   ══════════════════════════════════════════ */

let activePopover = null;
let popoverDismissHandler = null;

function showPopover(anchorEl, html, onClick) {
  removePopover();
  const pop = document.createElement('div');
  pop.className = 'edit-popover';
  pop.innerHTML = html;
  document.body.appendChild(pop);
  const rect = anchorEl.getBoundingClientRect();
  const sy = window.pageYOffset;
  const sx = window.pageXOffset;
  pop.style.top = (rect.bottom + 4 + sy) + 'px';
  pop.style.left = (rect.left + sx) + 'px';
  pop.style.maxHeight = Math.max(120, window.innerHeight - rect.bottom - 16) + 'px';
  requestAnimationFrame(() => {
    const pr = pop.getBoundingClientRect();
    if (pr.bottom > window.innerHeight - 8 && rect.top > pr.height + 8) {
      pop.style.top = (rect.top - pr.height - 4 + sy) + 'px';
      pop.style.maxHeight = Math.max(120, rect.top - 16) + 'px';
    }
    if (pr.right > window.innerWidth - 8) pop.style.left = Math.max(8 + sx, window.innerWidth - pr.width - 8 + sx) + 'px';
  });
  if (onClick) pop.addEventListener('click', onClick);
  activePopover = pop;
  popoverDismissHandler = function(e) {
    if (!pop.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) removePopover();
  };
  setTimeout(() => document.addEventListener('click', popoverDismissHandler), 0);
}

function removePopover() {
  if (activePopover) {
    const canvas = activePopover.querySelector('.color-wheel-canvas');
    if (canvas && canvas._cleanup) canvas._cleanup();
    activePopover.remove();
    activePopover = null;
  }
  if (popoverDismissHandler) { document.removeEventListener('click', popoverDismissHandler); popoverDismissHandler = null; }
}

function inlineEdit(el, currentValue, onCommit) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-edit';
  input.value = currentValue;
  el.replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    const val = input.value.trim();
    if (val !== currentValue) onCommit(val);
    renderDashboard(dashboardData);
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; renderDashboard(dashboardData); }
  });
}

/* ══════════════════════════════════════════
   HANDLERS DE EDIÇÃO
   ══════════════════════════════════════════ */

function editItemStatus(ci, gi, ii, el) {
  const item = dashboardData.cards[ci].grupos[gi].itens[ii];
  const raiz = dashboardData.tipos[item.tipo];
  if (!raiz || raiz.tipo !== 'enum') return;
  const html = buildPopoverOptions(null, raiz.estados.map(e => ({
    value: e.nome, label: e.nome, dotColor: e.cor, selected: item.valor === e.nome
  })));
  showPopover(el, html, function(e) {
    const opt = e.target.closest('.edit-popover-option');
    if (!opt) return;
    item.valor = opt.dataset.value;
    removePopover();
    renderDashboard(dashboardData);
  });
}

function editItemValue(ci, gi, ii, el) {
  const item = dashboardData.cards[ci].grupos[gi].itens[ii];
  inlineEdit(el, item.valor, function(val) { item.valor = val; });
}

function editItemNote(ci, gi, ii, el) {
  const item = dashboardData.cards[ci].grupos[gi].itens[ii];
  inlineEdit(el, item.nota, function(val) { item.nota = val; });
}

function editItemName(ci, gi, ii, el) {
  const item = dashboardData.cards[ci].grupos[gi].itens[ii];
  inlineEdit(el, item.nome, function(val) { item.nome = val; });
}

function editGroupName(ci, gi, el) {
  const card = dashboardData.cards[ci];
  const grupo = card.grupos[gi];
  const oldName = grupo.nome;
  inlineEdit(el, oldName, function(val) {
    grupo.nome = val;
    for (const gr of card.graficos) {
      const idx = gr.gruposRef.indexOf(oldName);
      if (idx !== -1) gr.gruposRef[idx] = val;
    }
  });
}

function editCardName(ci, el) {
  inlineEdit(el, dashboardData.cards[ci].nome, function(val) { dashboardData.cards[ci].nome = val; });
}

function editHeaderField(field, el) {
  inlineEdit(el, dashboardData[field], function(val) { dashboardData[field] = val; });
}

function editChartType(ci, chi, el) {
  const grafico = dashboardData.cards[ci].graficos[chi];
  const html = buildPopoverOptions(null, TIPOS_GRAFICO.map(t => ({ ...t, selected: grafico.tipo === t.value })));
  showPopover(el, html, function(e) {
    const opt = e.target.closest('.edit-popover-option');
    if (!opt) return;
    grafico.tipo = opt.dataset.value;
    removePopover();
    renderDashboard(dashboardData);
  });
}

function editChartData(ci, chi, el) {
  const card = dashboardData.cards[ci];
  const grafico = card.graficos[chi];
  const checkedIdxs = card.grupos.map((g, i) => grafico.gruposRef.includes(g.nome) ? i : -1).filter(i => i >= 0);
  const html = buildPopoverChecklist('Grupos de dados', card.grupos.map(g => g.nome), checkedIdxs);
  showPopover(el, html, function(e) {
    if (e.target.closest('[data-action="confirm"]')) {
      const pop = e.target.closest('.edit-popover');
      const newRefs = [];
      pop.querySelectorAll('input[type=checkbox]').forEach(c => {
        if (c.checked) newRefs.push(card.grupos[parseInt(c.dataset.grupo)].nome);
      });
      grafico.gruposRef = newRefs;
      removePopover();
      renderDashboard(dashboardData);
    }
  });
}

/* ── Helpers de coleta ── */

function getAllGroupNames() {
  const groups = [];
  for (const card of dashboardData.cards)
    for (const grupo of card.grupos)
      if (!groups.includes(grupo.nome)) groups.push(grupo.nome);
  return groups;
}

function getAllStateNames() {
  const states = [];
  for (const raiz of Object.values(dashboardData.tipos))
    if (raiz.tipo === 'enum')
      for (const e of raiz.estados)
        if (!states.includes(e.nome)) states.push(e.nome);
  return states;
}

function buildOptions(items, selected, emptyLabel) {
  let html = emptyLabel ? '<option value=""' + (!selected ? ' selected' : '') + '>' + emptyLabel + '</option>' : '';
  for (const item of items) html += '<option value="' + esc(item) + '"' + (selected === item ? ' selected' : '') + '>' + esc(item) + '</option>';
  return html;
}

function buildPopoverOptions(title, items) {
  let html = title ? '<div class="popover-title">' + esc(title) + '</div>' : '';
  for (const item of items) {
    const attrs = item.action
      ? ' data-action="' + esc(item.action) + '"'
      : ' data-value="' + esc(item.value !== undefined ? item.value : '') + '"';
    const cls = 'edit-popover-option' + (item.selected ? ' selected' : '') + (item.extraClass ? ' ' + item.extraClass : '');
    html += '<div class="' + cls + '"' + attrs + '>';
    if (item.dotColor) html += '<span class="legend-dot" style="background:' + item.dotColor + '"></span>';
    if (item.desc) {
      html += '<div><strong>' + esc(item.label) + '</strong><br><span style="font-size:10px;color:var(--text3)">' + esc(item.desc) + '</span></div>';
    } else {
      html += esc(item.label);
    }
    html += '</div>';
  }
  return html;
}

function buildPopoverChecklist(title, items, checkedIdxs) {
  let html = '<div class="popover-title">' + esc(title) + '</div>';
  for (let i = 0; i < items.length; i++) {
    html += '<label class="popover-check"><input type="checkbox" data-grupo="' + i + '"' + (checkedIdxs.includes(i) ? ' checked' : '') + '> ' + esc(items[i]) + '</label>';
  }
  html += '<div class="popover-actions"><button class="btn popover-btn" data-action="confirm">Confirmar</button></div>';
  return html;
}

/* ── KPI (cabecalho) ── */

function editKpiLabel(ki, el) {
  const kpi = dashboardData.cabecalho[ki];
  const oldLabel = kpi.label;
  inlineEdit(el, oldLabel, function(val) {
    kpi.label = val;
    for (const other of dashboardData.cabecalho) {
      if (other.incluir === oldLabel) other.incluir = val;
    }
  });
}

function editKpiConfig(ki, el) {
  const kpi = dashboardData.cabecalho[ki];
  const isPct = kpi.funcao === 'porcentagem';
  const groups = getAllGroupNames();
  const states = getAllStateNames();
  const kpiLabels = dashboardData.cabecalho.filter((_, i) => i !== ki).map(k => k.label);

  const funcoes = [
    { v: 'contagem', l: 'Contagem' },
    { v: 'soma', l: 'Soma' },
    { v: 'media', l: 'Media' },
    { v: 'maximo', l: 'Maior valor' },
    { v: 'minimo', l: 'Menor valor' },
    { v: 'porcentagem', l: 'Porcentagem' }
  ];
  const funcaoOpts = funcoes.map(f => '<option value="' + f.v + '"' + (kpi.funcao === f.v ? ' selected' : '') + '>' + f.l + '</option>').join('');

  const fonteItems = ['*'].concat(groups);
  const pctFiltro = kpi.numerador?.filtro || '';
  const pctFonte = kpi.numerador?.fonte || kpi.fonte || '*';

  let html =
    '<div class="popover-title">Configurar indicador</div><div class="popover-form">' +
    '<label class="popover-field-label">O que calcular?</label>' +
    '<select class="inline-edit popover-input" data-field="funcao">' + funcaoOpts + '</select>' +
    '<div data-container="standard-fields"' + (isPct ? ' style="display:none"' : '') + '>' +
    '<label class="popover-field-label">Buscar itens de</label>' +
    '<select class="inline-edit popover-input" data-field="fonte">' + buildOptions(fonteItems, kpi.fonte || '*') + '</select>' +
    '<label class="popover-field-label">Apenas com status</label>' +
    '<select class="inline-edit popover-input" data-field="filtro">' + buildOptions(states, kpi.filtro, 'todos') + '</select>' +
    '</div>' +
    '<div data-container="pct-fields"' + (isPct ? '' : ' style="display:none"') + '>' +
    '<label class="popover-field-label">% de itens com status</label>' +
    '<select class="inline-edit popover-input" data-field="pct-filtro">' + buildOptions(states, pctFiltro, 'todos') + '</select>' +
    '<label class="popover-field-label">Buscando de</label>' +
    '<select class="inline-edit popover-input" data-field="pct-fonte">' + buildOptions(fonteItems, pctFonte) + '</select>' +
    '</div>' +
    '<label class="popover-field-label">Legenda auxiliar</label>' +
    '<input type="text" class="inline-edit popover-input" data-field="sub" value="' + esc(kpi.sub || '') + '" placeholder="opcional">' +
    '<label class="popover-field-label">Exibir dentro de</label>' +
    '<select class="inline-edit popover-input" data-field="incluir">' + buildOptions(kpiLabels, kpi.incluir, 'nenhum') + '</select>' +
    '<button class="btn popover-btn" data-action="save-kpi">Salvar</button></div>';

  showPopover(el, html, function(e) {
    if (!e.target.closest('[data-action="save-kpi"]')) return;
    const pop = e.target.closest('.edit-popover');
    const funcao = pop.querySelector('[data-field="funcao"]').value;
    kpi.funcao = funcao;
    kpi.sub = pop.querySelector('[data-field="sub"]').value.trim();
    kpi.incluir = pop.querySelector('[data-field="incluir"]').value.trim();
    if (funcao === 'porcentagem') {
      const pf = pop.querySelector('[data-field="pct-filtro"]').value.trim();
      const ps = pop.querySelector('[data-field="pct-fonte"]').value.trim() || '*';
      kpi.fonte = '';
      kpi.filtro = '';
      kpi.numerador = { funcao: 'contagem', fonte: ps, filtro: pf };
      kpi.denominador = { funcao: 'contagem', fonte: ps, filtro: '' };
    } else {
      kpi.fonte = pop.querySelector('[data-field="fonte"]').value.trim() || '*';
      kpi.filtro = pop.querySelector('[data-field="filtro"]').value.trim();
      kpi.numerador = null;
      kpi.denominador = null;
    }
    removePopover();
    renderDashboard(dashboardData);
  });

  const pop = activePopover;
  pop.querySelector('[data-field="funcao"]').addEventListener('change', function() {
    const pct = this.value === 'porcentagem';
    pop.querySelector('[data-container="standard-fields"]').style.display = pct ? 'none' : '';
    pop.querySelector('[data-container="pct-fields"]').style.display = pct ? '' : 'none';
  });
}

function addKpi() {
  dashboardData.cabecalho.push({ label: 'Novo indicador', funcao: 'contagem', fonte: '*', filtro: '', sub: '', incluir: '', numerador: null, denominador: null });
  renderDashboard(dashboardData);
}

function removeKpi(ki) {
  const label = dashboardData.cabecalho[ki].label;
  dashboardData.cabecalho.splice(ki, 1);
  dashboardData.cabecalho = dashboardData.cabecalho.filter(k => k.incluir !== label);
  renderDashboard(dashboardData);
}

/* ── Add / Remove ── */

function addItem(ci, gi, anchorEl) {
  const grupo = dashboardData.cards[ci].grupos[gi];
  if (grupo.itens.length > 0) {
    const raizName = grupo.itens[0].raiz;
    const raiz = dashboardData.tipos[raizName];
    const def = raiz.tipo === 'enum' ? (raiz.estados[0]?.nome || '') : '0';
    grupo.itens.push({ tipo: raizName, nome: 'Novo item', valor: def, nota: '' });
    renderDashboard(dashboardData);
    return;
  }
  const raizItems = Object.entries(dashboardData.tipos).map(([name, raiz]) => ({
    value: name, label: name,
    desc: raiz.tipo === 'enum' ? 'enum (' + raiz.estados.map(e => e.nome).join(', ') + ')' : 'numero (' + raiz.unidade + ')'
  }));
  raizItems.push({ action: 'create-raiz', label: '+ Criar novo TIPO', extraClass: 'popover-option-create' });
  const html = buildPopoverOptions('Tipo do item', raizItems);
  showPopover(anchorEl, html, function(e) {
    const opt = e.target.closest('.edit-popover-option');
    if (!opt) return;
    if (opt.dataset.action === 'create-raiz') {
      removePopover();
      openCreateTipoPopover(anchorEl, function(raizName) {
        const raiz = dashboardData.tipos[raizName];
        const def = raiz.tipo === 'enum' ? (raiz.estados[0]?.nome || '') : '0';
        grupo.itens.push({ tipo: raizName, nome: 'Novo item', valor: def, nota: '' });
        renderDashboard(dashboardData);
      });
      return;
    }
    const raizName = opt.dataset.value;
    if (!raizName) return;
    const raiz = dashboardData.tipos[raizName];
    const def = raiz.tipo === 'enum' ? (raiz.estados[0]?.nome || '') : '0';
    grupo.itens.push({ tipo: raizName, nome: 'Novo item', valor: def, nota: '' });
    removePopover();
    renderDashboard(dashboardData);
  });
}

function removeItem(ci, gi, ii) {
  dashboardData.cards[ci].grupos[gi].itens.splice(ii, 1);
  renderDashboard(dashboardData);
}

function addGroup(ci) {
  dashboardData.cards[ci].grupos.push({ nome: 'Novo grupo', itens: [] });
  renderDashboard(dashboardData);
}

function removeGroup(ci, gi) {
  const card = dashboardData.cards[ci];
  const removedName = card.grupos[gi].nome;
  card.grupos.splice(gi, 1);
  for (const gr of card.graficos) {
    const idx = gr.gruposRef.indexOf(removedName);
    if (idx !== -1) gr.gruposRef.splice(idx, 1);
  }
  renderDashboard(dashboardData);
}

function addCard() {
  dashboardData.cards.push({ nome: 'Novo card', cor: '#94A3B8', grupos: [], graficos: [] });
  renderDashboard(dashboardData);
}

function removeCard(ci) {
  dashboardData.cards.splice(ci, 1);
  renderDashboard(dashboardData);
}

const COLOR_PRESETS = ['#1D9E75','#378ADD','#BA7517','#7F77DD','#EF4444','#F97316','#94A3B8','#0F172A'];

function hexToHSV(hex) {
  hex = hex.replace('#','');
  if (hex.length === 3) hex = hex.split('').map(c=>c+c).join('');
  const r=parseInt(hex.slice(0,2),16)/255, g=parseInt(hex.slice(2,4),16)/255, b=parseInt(hex.slice(4,6),16)/255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  let h=0;
  if(d){ if(max===r) h=((g-b)/d%6+6)%6; else if(max===g) h=(b-r)/d+2; else h=(r-g)/d+4; h*=60; }
  return { h, s: max?d/max:0, v: max };
}

function hsvToHex(h,s,v) {
  const f=n=>{const k=(n+h/60)%6;return v-v*s*Math.max(0,Math.min(k,4-k,1));};
  const x=n=>Math.round(Math.max(0,Math.min(1,f(n)))*255).toString(16).padStart(2,'0');
  return '#'+x(5)+x(3)+x(1);
}

function initColorWheel(canvas, initialHex, onChange) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, cx = W/2, cy = H/2;
  const outerR = cx - 4, innerR = outerR * 0.72;
  const halfSq = (innerR * Math.SQRT2) / 2;
  let {h, s, v} = hexToHSV(initialHex);
  let dragging = null;

  function drawWheel() {
    for (let i = 0; i < 360; i++) {
      const a1 = (i/360)*Math.PI*2 - Math.PI/2;
      const a2 = ((i+1)/360)*Math.PI*2 - Math.PI/2;
      ctx.beginPath();
      ctx.moveTo(cx+Math.cos(a1)*innerR, cy+Math.sin(a1)*innerR);
      ctx.arc(cx, cy, outerR, a1, a2);
      ctx.arc(cx, cy, innerR, a2, a1, true);
      ctx.closePath();
      ctx.fillStyle = 'hsl('+i+',100%,50%)';
      ctx.fill();
    }
  }

  function drawSquare() {
    const x0=cx-halfSq, y0=cy-halfSq, sz=halfSq*2;
    const gH=ctx.createLinearGradient(x0,0,x0+sz,0);
    gH.addColorStop(0,'#fff'); gH.addColorStop(1,'hsl('+h+',100%,50%)');
    ctx.fillStyle=gH; ctx.fillRect(x0,y0,sz,sz);
    const gV=ctx.createLinearGradient(0,y0,0,y0+sz);
    gV.addColorStop(0,'rgba(0,0,0,0)'); gV.addColorStop(1,'#000');
    ctx.fillStyle=gV; ctx.fillRect(x0,y0,sz,sz);
  }

  function drawCursors() {
    const hAngle=(h/360)*Math.PI*2 - Math.PI/2;
    const ringR=(outerR+innerR)/2;
    const hx=cx+Math.cos(hAngle)*ringR, hy=cy+Math.sin(hAngle)*ringR;
    [['#fff',8,2.5],['rgba(0,0,0,.4)',7,1]].forEach(([c,r,w])=>{
      ctx.beginPath(); ctx.arc(hx,hy,r,0,Math.PI*2);
      ctx.strokeStyle=c; ctx.lineWidth=w; ctx.stroke();
    });
    const sx=cx-halfSq+s*halfSq*2, sy=cy-halfSq+(1-v)*halfSq*2;
    [['#fff',7,2],['rgba(0,0,0,.4)',6,1]].forEach(([c,r,w])=>{
      ctx.beginPath(); ctx.arc(sx,sy,r,0,Math.PI*2);
      ctx.strokeStyle=c; ctx.lineWidth=w; ctx.stroke();
    });
  }

  function redraw() {
    ctx.clearRect(0,0,W,H);
    drawWheel(); drawSquare(); drawCursors();
    onChange(hsvToHex(h,s,v));
  }

  function xy(e) {
    const r=canvas.getBoundingClientRect();
    const ev=e.touches?e.touches[0]:e;
    return { x:(ev.clientX-r.left)*(W/r.width), y:(ev.clientY-r.top)*(H/r.height) };
  }

  function onDown(e) {
    const {x,y}=xy(e), dx=x-cx, dy=y-cy, dist=Math.sqrt(dx*dx+dy*dy);
    if(dist>=innerR&&dist<=outerR) dragging='wheel';
    else if(Math.abs(dx)<=halfSq&&Math.abs(dy)<=halfSq) dragging='sq';
    if(dragging) onMove(e);
    e.preventDefault();
  }

  function onMove(e) {
    if(!dragging) return;
    const {x,y}=xy(e.touches?e:e), dx=x-cx, dy=y-cy;
    if(dragging==='wheel') h=((Math.atan2(dy,dx)+Math.PI/2+Math.PI*2)%(Math.PI*2))/(Math.PI*2)*360;
    else { s=Math.max(0,Math.min(1,(x-(cx-halfSq))/(halfSq*2))); v=Math.max(0,Math.min(1,1-(y-(cy-halfSq))/(halfSq*2))); }
    redraw(); e.preventDefault();
  }

  function onUp() { dragging=null; }

  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('touchstart', onDown, {passive:false});
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, {passive:false});
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchend', onUp);
  canvas._cleanup = ()=>{
    window.removeEventListener('mousemove',onMove);
    window.removeEventListener('touchmove',onMove);
    window.removeEventListener('mouseup',onUp);
    window.removeEventListener('touchend',onUp);
  };
  redraw();
  return { setHex(hex){ const c=hexToHSV(hex); h=c.h; s=c.s; v=c.v; redraw(); } };
}

function colorPickerPopover(anchorEl, title, currentColor, onApply) {
  const presetsHTML = COLOR_PRESETS.map(c =>
    '<span class="color-preset" style="background:' + c + '" data-color="' + c + '"></span>'
  ).join('');
  const html =
    '<div class="popover-title">' + esc(title) + '</div>' +
    '<div class="color-wheel-wrap"><canvas class="color-wheel-canvas" width="180" height="180"></canvas>' +
    '<div class="color-picker-row">' +
    '<span class="color-picker-swatch" style="background:' + esc(currentColor) + '"></span>' +
    '<input type="text" class="inline-edit color-hex-input" value="' + esc(currentColor) + '" maxlength="7" placeholder="#000000">' +
    '<button class="btn popover-btn" data-action="apply-color" style="width:auto;padding:4px 10px">OK</button>' +
    '</div></div>' +
    '<div class="color-presets-row">' + presetsHTML + '</div>';

  let wheel = null;

  showPopover(anchorEl, html, function(e) {
    const preset = e.target.closest('.color-preset');
    if (preset) {
      const c = preset.dataset.color;
      if (wheel) wheel.setHex(c);
      updateColorUI(activePopover, c);
      return;
    }
    if (e.target.closest('[data-action="apply-color"]')) {
      onApply(activePopover.querySelector('.color-hex-input').value);
      removePopover();
    }
  });

  const hexInput = activePopover.querySelector('.color-hex-input');
  hexInput.addEventListener('input', function() {
    if (/^#[0-9A-Fa-f]{6}$/.test(this.value)) {
      if (wheel) wheel.setHex(this.value);
      const sw = activePopover.querySelector('.color-picker-swatch');
      if (sw) sw.style.background = this.value;
    }
  });

  wheel = initColorWheel(activePopover.querySelector('.color-wheel-canvas'), currentColor, function(hex) {
    updateColorUI(activePopover, hex);
  });
}

function updateColorUI(pop, hex) {
  const sw = pop.querySelector('.color-picker-swatch');
  const inp = pop.querySelector('.color-hex-input');
  if (sw) sw.style.background = hex;
  if (inp && document.activeElement !== inp) inp.value = hex;
}

function editCardColor(ci, el) {
  const card = dashboardData.cards[ci];
  colorPickerPopover(el, 'Cor do card', card.cor, function(color) {
    card.cor = color;
    renderDashboard(dashboardData);
  });
}

function editLegendColor(label, el) {
  let currentColor = '#94A3B8';
  for (const raiz of Object.values(dashboardData.tipos)) {
    if (raiz.tipo !== 'enum') continue;
    const estado = raiz.estados.find(e => e.nome === label);
    if (estado) { currentColor = estado.cor; break; }
  }
  colorPickerPopover(el, 'Cor: ' + label, currentColor, function(color) {
    for (const raiz of Object.values(dashboardData.tipos)) {
      if (raiz.tipo !== 'enum') continue;
      const estado = raiz.estados.find(e => e.nome === label);
      if (estado) estado.cor = color;
    }
    renderDashboard(dashboardData);
  });
}

function addChart(ci, anchorEl) {
  const card = dashboardData.cards[ci];
  const html = buildPopoverOptions('Tipo de grafico', TIPOS_GRAFICO);
  showPopover(anchorEl, html, function(e) {
    const opt = e.target.closest('.edit-popover-option');
    if (!opt) return;
    removePopover();
    if (opt.dataset.value === 'linhas') {
      openLinhaModal(ci);
    } else {
      card.graficos.push({ tipo: opt.dataset.value, gruposRef: [] });
      renderDashboard(dashboardData);
    }
  });
}

function removeChart(ci, gri) {
  dashboardData.cards[ci].graficos.splice(gri, 1);
  renderDashboard(dashboardData);
}

/* ── Modal: Novo gráfico de linhas ── */
let _linhasModalChart = null;

function openLinhaModal(ci) {
  const card = dashboardData.cards[ci];

  const state = {
    xEnumKey: null,
    selectedIdx: 0,
    datasets: [{ nome: 'Dataset 1', tipoYKey: null, grupoNome: null, color: COLOR_PRESETS[0] }]
  };

  function enumKeys() { return Object.keys(dashboardData.tipos).filter(k => dashboardData.tipos[k].tipo === 'enum'); }
  function numeroKeys() { return Object.keys(dashboardData.tipos).filter(k => dashboardData.tipos[k].tipo === 'numero'); }
  function currDs() { return state.datasets[state.selectedIdx]; }

  function buildBody() {
    const ds = currDs();

    const xBtns = enumKeys().map(k =>
      '<button class="lm-tipo-btn' + (state.xEnumKey === k ? ' lm-active' : '') + '" data-action="set-x" data-key="' + esc(k) + '">' +
      '<span class="lm-tag lm-tag-enum">enum</span>' + esc(k) + '</button>'
    ).join('') + '<button class="lm-tipo-btn lm-dashed" data-action="create-x">+ enum</button>';

    const yBtns = numeroKeys().map(k =>
      '<button class="lm-tipo-btn' + (ds.tipoYKey === k ? ' lm-active' : '') + '" data-action="set-y" data-key="' + esc(k) + '">' +
      '<span class="lm-tag lm-tag-num">num</span>' + esc(k) + '</button>'
    ).join('') + '<button class="lm-tipo-btn lm-dashed" data-action="create-y">+ numero</button>';

    const grupoBtns = card.grupos.map(g =>
      '<button class="lm-tipo-btn' + (ds.grupoNome === g.nome ? ' lm-active' : '') + '" data-action="set-grupo" data-nome="' + esc(g.nome) + '">' +
      esc(g.nome) + '</button>'
    ).join('') + '<button class="lm-tipo-btn lm-dashed" data-action="create-grupo">+ grupo</button>';

    const dsTabs = state.datasets.map((d, i) =>
      '<div class="lm-ds-tab' + (i === state.selectedIdx ? ' lm-active' : '') + '" data-action="sel-ds" data-idx="' + i + '">' +
      '<span class="lm-ds-dot" style="background:' + d.color + '"></span>' +
      '<span class="lm-ds-label">' + esc(d.nome) + '</span>' +
      (state.datasets.length > 1 ? '<span class="lm-ds-rm" data-action="rm-ds" data-idx="' + i + '">&times;</span>' : '') +
      '</div>'
    ).join('') + '<div class="lm-ds-tab lm-dashed" data-action="add-ds">+</div>';

    return '<div class="lm-body">' +
      '<div class="lm-left"><canvas id="lm-canvas"></canvas></div>' +
      '<div class="lm-right">' +
        '<div>' +
          '<div class="lm-label">Eixo X <span class="lm-hint">todos os datasets</span></div>' +
          '<div class="lm-btns">' + xBtns + '</div>' +
        '</div>' +
        '<hr class="lm-sep">' +
        '<div class="lm-ds-row">' + dsTabs + '</div>' +
        '<div>' +
          '<div class="lm-label">Nome</div>' +
          '<input id="lm-nome" class="inline-edit lm-nome-input" value="' + esc(ds.nome) + '">' +
        '</div>' +
        '<div>' +
          '<div class="lm-label">Eixo Y</div>' +
          '<div class="lm-btns">' + yBtns + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="lm-label">Grupo de dados</div>' +
          '<div class="lm-btns">' + grupoBtns + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function renderPreview() {
    const canvas = document.getElementById('lm-canvas');
    if (!canvas) return;
    if (_linhasModalChart) { _linhasModalChart.destroy(); _linhasModalChart = null; }

    const xEnum = state.xEnumKey ? dashboardData.tipos[state.xEnumKey] : null;
    const labels = xEnum ? xEnum.estados.map(e => e.nome) : ['A', 'B', 'C', 'D', 'E'];

    const chartDatasets = state.datasets.map(ds => {
      const grupo = card.grupos.find(g => g.nome === ds.grupoNome);
      let data;
      if (grupo && grupo.itens.length && xEnum) {
        const map = Object.fromEntries(grupo.itens.map(i => [i.nome, parseFloat(i.valor) ?? null]));
        data = labels.map(l => map[l] ?? null);
      } else {
        data = labels.map(() => null);
      }
      return {
        label: ds.nome, data,
        borderColor: ds.color, backgroundColor: ds.color + '20',
        fill: state.datasets.length === 1,
        tension: 0.3, pointRadius: 4, spanGaps: true
      };
    });

    const dark = document.documentElement.classList.contains('dark');
    const textColor = dark ? '#94A3B8' : '#64748B';
    const gridColor = dark ? '#334155' : '#E2E8F0';

    _linhasModalChart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: chartDatasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: state.datasets.length > 1, labels: { color: textColor, font: { size: 11 }, boxWidth: 12, padding: 10 } }
        },
        scales: {
          x: { ticks: { color: textColor, font: { size: 10 } }, grid: { display: false } },
          y: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor }, beginAtZero: true }
        }
      }
    });
  }

  function refresh() {
    if (_linhasModalChart) { _linhasModalChart.destroy(); _linhasModalChart = null; }
    document.getElementById('modal-body').innerHTML = buildBody();
    renderPreview();
    const nomeInput = document.getElementById('lm-nome');
    if (nomeInput) nomeInput.addEventListener('input', function() { currDs().nome = this.value; });
  }

  function confirmLinhas() {
    if (!state.xEnumKey) { alert('Selecione um TIPO enum para o Eixo X.'); return; }
    const bad = state.datasets.find(d => !d.tipoYKey);
    if (bad) { alert('Dataset "' + bad.nome + '" precisa de um TIPO numero para o Eixo Y.'); return; }

    state.datasets.forEach(ds => {
      if (!ds.grupoNome) ds.grupoNome = ds.nome;
      if (!card.grupos.find(g => g.nome === ds.grupoNome)) card.grupos.push({ nome: ds.grupoNome, itens: [] });
    });

    card.graficos.push({ tipo: 'linhas', gruposRef: state.datasets.map(d => d.grupoNome) });
    _closeLinhaModal();
    renderDashboard(dashboardData);
  }

  const _lmAbort = new AbortController();

  function _closeLinhaModal() {
    _lmAbort.abort();
    if (_linhasModalChart) { _linhasModalChart.destroy(); _linhasModalChart = null; }
    document.querySelector('.modal').classList.remove('modal-linhas');
    document.querySelector('.modal-close').setAttribute('onclick', 'closeModal()');
    closeModal();
  }

  // Abrir modal
  document.querySelector('.modal').classList.add('modal-linhas');
  openModal('Novo gráfico de linhas', buildBody(),
    '<button class="btn btn-ghost" id="lm-cancel">Cancelar</button>' +
    '<button class="btn btn-primary" id="lm-confirm">Confirmar</button>'
  );
  document.getElementById('lm-cancel').onclick = _closeLinhaModal;
  document.getElementById('lm-confirm').onclick = confirmLinhas;
  document.querySelector('.modal-close').onclick = _closeLinhaModal;
  renderPreview();

  const nomeInput = document.getElementById('lm-nome');
  if (nomeInput) nomeInput.addEventListener('input', function() { currDs().nome = this.value; });

  // Handler delegado — AbortController garante que apenas um listener ativo por sessão
  document.getElementById('modal-body').addEventListener('click', function(e) {
    const selDs = e.target.closest('[data-action="sel-ds"]');
    if (selDs && !e.target.closest('[data-action="rm-ds"]')) {
      state.selectedIdx = parseInt(selDs.dataset.idx); refresh(); return;
    }
    const rmDs = e.target.closest('[data-action="rm-ds"]');
    if (rmDs) {
      const idx = parseInt(rmDs.dataset.idx);
      state.datasets.splice(idx, 1);
      if (state.selectedIdx >= state.datasets.length) state.selectedIdx = state.datasets.length - 1;
      refresh(); return;
    }
    if (e.target.closest('[data-action="add-ds"]')) {
      const color = COLOR_PRESETS[state.datasets.length % COLOR_PRESETS.length];
      state.datasets.push({ nome: 'Dataset ' + (state.datasets.length + 1), tipoYKey: null, grupoNome: null, color });
      state.selectedIdx = state.datasets.length - 1;
      refresh(); return;
    }
    const setX = e.target.closest('[data-action="set-x"]');
    if (setX) { state.xEnumKey = setX.dataset.key; refresh(); return; }
    if (e.target.closest('[data-action="create-x"]')) {
      openCreateTipoPopover(e.target.closest('[data-action="create-x"]'), function(key) {
        state.xEnumKey = key; refresh();
      }, 'enum');
      return;
    }
    const setY = e.target.closest('[data-action="set-y"]');
    if (setY) { currDs().tipoYKey = setY.dataset.key; refresh(); return; }
    if (e.target.closest('[data-action="create-y"]')) {
      openCreateTipoPopover(e.target.closest('[data-action="create-y"]'), function(key) {
        currDs().tipoYKey = key; refresh();
      }, 'numero');
      return;
    }
    const setGrupo = e.target.closest('[data-action="set-grupo"]');
    if (setGrupo) { currDs().grupoNome = setGrupo.dataset.nome; refresh(); return; }
    if (e.target.closest('[data-action="create-grupo"]')) {
      const nome = prompt('Nome do novo grupo:');
      if (nome && nome.trim()) {
        const n = nome.trim();
        if (!card.grupos.find(g => g.nome === n)) card.grupos.push({ nome: n, itens: [] });
        currDs().grupoNome = n; refresh();
      }
    }
  }, { signal: _lmAbort.signal });
}

function openCreateTipoPopover(anchorEl, callback, fixedTipo) {
  let tipoAtual = fixedTipo || 'enum';
  let estados = [
    { cor: COLOR_PRESETS[0], nome: '' },
    { cor: COLOR_PRESETS[1], nome: '' }
  ];

  function syncFromDOM() {
    if (!activePopover) return;
    activePopover.querySelectorAll('.raiz-estado-row').forEach((row, i) => {
      if (estados[i]) {
        estados[i].cor = row.querySelector('.raiz-estado-cor').value;
        estados[i].nome = row.querySelector('.raiz-estado-nome').value;
      }
    });
  }

  function buildConfig() {
    if (tipoAtual !== 'enum') {
      return '<input type="text" class="inline-edit popover-input" placeholder="Unidade (ex: ton, R$, %)" data-field="tipo-unidade">';
    }
    let rows = '';
    for (let i = 0; i < estados.length; i++) {
      rows += '<div class="raiz-estado-row">' +
        '<input type="color" class="raiz-estado-cor" value="' + estados[i].cor + '">' +
        '<input type="text" class="inline-edit raiz-estado-nome" placeholder="Nome do estado" value="' + esc(estados[i].nome) + '">' +
        '<button class="edit-action-remove" data-action="rm-estado" data-idx="' + i + '">&times;</button>' +
        '</div>';
    }
    return '<div class="raiz-estados-list">' + rows + '</div>' +
      '<button class="raiz-add-estado" data-action="add-estado">+ Adicionar estado</button>';
  }

  function buildHTML(nameVal, unidadeVal) {
    const typeLabel = tipoAtual === 'enum' ? 'Novo TIPO enum' : 'Novo TIPO numero';
    return '<div class="popover-title">' + (fixedTipo ? typeLabel : 'Novo TIPO') + '</div>' +
      '<div class="popover-form">' +
      '<input type="text" class="inline-edit popover-input" placeholder="Nome (ex: tarefa)" data-field="tipo-name" value="' + esc(nameVal||'') + '">' +
      (fixedTipo ? '' :
        '<div class="tipo-btns">' +
        '<button class="btn' + (tipoAtual==='enum'?' btn-primary':'') + '" data-tipo="enum">Enum</button>' +
        '<button class="btn' + (tipoAtual==='numero'?' btn-primary':'') + '" data-tipo="numero">Numero</button>' +
        '</div>'
      ) +
      '<div class="raiz-config">' + buildConfig() + '</div>' +
      '<button class="btn popover-btn" data-action="create-tipo">Criar</button>' +
      '</div>';
  }

  function rerender() {
    if (!activePopover) return;
    const nameVal = activePopover.querySelector('[data-field="tipo-name"]')?.value || '';
    const unidadeVal = activePopover.querySelector('[data-field="tipo-unidade"]')?.value || '';
    activePopover.querySelector('.raiz-config').innerHTML = buildConfig();
    if (unidadeVal && activePopover.querySelector('[data-field="tipo-unidade"]'))
      activePopover.querySelector('[data-field="tipo-unidade"]').value = unidadeVal;
  }

  showPopover(anchorEl, buildHTML(), function(e) {
    const pop = activePopover;
    if (!pop) return;

    const tipoBtnEl = e.target.closest('[data-tipo]');
    if (tipoBtnEl) {
      e.stopPropagation();
      syncFromDOM();
      tipoAtual = tipoBtnEl.dataset.tipo;
      pop.querySelectorAll('[data-tipo]').forEach(b => b.classList.toggle('btn-primary', b.dataset.tipo === tipoAtual));
      rerender();
      return;
    }

    if (e.target.closest('[data-action="add-estado"]')) {
      e.stopPropagation();
      syncFromDOM();
      estados.push({ cor: COLOR_PRESETS[estados.length % COLOR_PRESETS.length], nome: '' });
      rerender();
      return;
    }

    const rmEl = e.target.closest('[data-action="rm-estado"]');
    if (rmEl) {
      e.stopPropagation();
      syncFromDOM();
      estados.splice(parseInt(rmEl.dataset.idx), 1);
      if (!estados.length) estados.push({ cor: COLOR_PRESETS[0], nome: '' });
      rerender();
      return;
    }

    if (e.target.closest('[data-action="create-tipo"]')) {
      const name = pop.querySelector('[data-field="tipo-name"]')?.value.trim();
      if (!name) return;
      if (tipoAtual === 'enum') {
        syncFromDOM();
        const validos = estados.filter(e => e.nome.trim());
        if (!validos.length) return;
        dashboardData.tipos[name] = { tipo: 'enum', estados: validos };
      } else {
        const unidade = pop.querySelector('[data-field="tipo-unidade"]')?.value.trim() || '';
        dashboardData.tipos[name] = { tipo: 'numero', unidade };
      }
      removePopover();
      if (callback) callback(name);
    }
  });
}

/* ══════════════════════════════════════════
   EVENT DELEGATION
   ══════════════════════════════════════════ */

function handleGridClick(e) {
  if (!editMode) return;
  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    e.stopPropagation();
    const action = actionEl.dataset.action;
    const ci = parseInt(actionEl.dataset.cardIdx);
    const gi = actionEl.dataset.groupIdx !== undefined ? parseInt(actionEl.dataset.groupIdx) : -1;
    const ii = actionEl.dataset.itemIdx !== undefined ? parseInt(actionEl.dataset.itemIdx) : -1;
    const gri = actionEl.dataset.chartIdx !== undefined ? parseInt(actionEl.dataset.chartIdx) : -1;
    if (action === 'remove-card') removeCard(ci);
    else if (action === 'remove-group') removeGroup(ci, gi);
    else if (action === 'remove-item') removeItem(ci, gi, ii);
    else if (action === 'remove-chart') removeChart(ci, gri);
    else if (action === 'add-item') addItem(ci, gi, actionEl);
    else if (action === 'add-group') addGroup(ci);
    else if (action === 'add-card') addCard();
    else if (action === 'add-chart') addChart(ci, actionEl);
    return;
  }
  const editEl = e.target.closest('[data-editable]');
  if (!editEl) return;
  const type = editEl.dataset.editable;
  const ci = editEl.dataset.cardIdx !== undefined ? parseInt(editEl.dataset.cardIdx) : -1;
  const gi = editEl.dataset.groupIdx !== undefined ? parseInt(editEl.dataset.groupIdx) : -1;
  const ii = editEl.dataset.itemIdx !== undefined ? parseInt(editEl.dataset.itemIdx) : -1;
  const chi = editEl.dataset.chartIdx !== undefined ? parseInt(editEl.dataset.chartIdx) : -1;

  if (type === 'status') editItemStatus(ci, gi, ii, editEl);
  else if (type === 'value') editItemValue(ci, gi, ii, editEl);
  else if (type === 'note') editItemNote(ci, gi, ii, editEl);
  else if (type === 'item-name') editItemName(ci, gi, ii, editEl);
  else if (type === 'group-name') editGroupName(ci, gi, editEl);
  else if (type === 'card-name') editCardName(ci, editEl);
  else if (type === 'card-color') editCardColor(ci, editEl);
  else if (type === 'legend-color') editLegendColor(editEl.dataset.label, editEl);
  else if (type === 'chart-type') editChartType(ci, chi, editEl);
  else if (type === 'chart-data') editChartData(ci, chi, editEl);
}

function handleKpiClick(e) {
  if (!editMode) return;
  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    e.stopPropagation();
    const action = actionEl.dataset.action;
    const ki = actionEl.dataset.kpiIdx !== undefined ? parseInt(actionEl.dataset.kpiIdx) : -1;
    if (action === 'remove-kpi') removeKpi(ki);
    else if (action === 'add-kpi') addKpi();
    return;
  }
  const editEl = e.target.closest('[data-editable]');
  if (!editEl) return;
  const type = editEl.dataset.editable;
  const ki = parseInt(editEl.dataset.kpiIdx);
  if (type === 'kpi-label') editKpiLabel(ki, editEl);
  else if (type === 'kpi-config') editKpiConfig(ki, editEl);
}

function handleHeaderClick(e) {
  if (!editMode) return;
  const editEl = e.target.closest('[data-editable]');
  if (!editEl) return;
  const field = editEl.dataset.editable;
  if (['marca', 'titulo', 'subtitulo'].includes(field)) editHeaderField(field, editEl);
}

/* ══════════════════════════════════════════
   MODO DE EDIÇÃO
   ══════════════════════════════════════════ */

function enterEditMode() {
  dataSnapshot = JSON.parse(JSON.stringify(dashboardData));
  editMode = true;
  viewMode = false;
  updateModeUI();
  renderDashboard(dashboardData);
}

function exitEditMode() {
  editMode = false;
  viewMode = false;
  dataSnapshot = null;
  updateModeUI();
  renderDashboard(dashboardData);
}

function enterViewMode() {
  editMode = false;
  viewMode = true;
  updateModeUI();
  closeModal();
  renderDashboard(dashboardData);
}

function discardEdits() {
  dashboardData = JSON.parse(JSON.stringify(dataSnapshot));
  dataSnapshot = null;
  editMode = false;
  viewMode = false;
  updateModeUI();
  closeModal();
  renderDashboard(dashboardData);
}

function backToEdit() {
  editMode = true;
  viewMode = false;
  updateModeUI();
  closeModal();
  renderDashboard(dashboardData);
}

function updateModeUI() {
  document.getElementById('edit-bar').classList.toggle('hidden', !editMode);
  document.getElementById('view-bar').classList.toggle('hidden', !viewMode);
  document.body.classList.toggle('editing', editMode);
  document.body.classList.toggle('viewing', viewMode);
}

/* ══════════════════════════════════════════
   TEMPLATE
   ══════════════════════════════════════════ */

function generateTemplate() {
  return `TITULO: Marca | Titulo do Dashboard | Subtitulo

TIPO tarefa = enum(concluido: #1D9E75, pendente: #94A3B8)
TIPO fase = enum(entregue: #1D9E75, em andamento: #378ADD, planejado: #94A3B8, cancelado: #EF4444)
TIPO producao = numero(ton)

CABECALHO
  Total de itens | contagem: *
  Concluidos | incluir: Total de itens | contagem: * | filtro: concluido
  Pendentes | incluir: Total de itens | contagem: * | filtro: pendente
  Producao media | media: Producao Anual | sub: ton/ano
  Melhor safra | maximo: Producao Anual | sub: recorde
  Producao total | soma: Producao Anual | sub: acumulado
  Progresso | porcentagem: contagem: * filtro: concluido / contagem: * | sub: do total

CARD Exemplo Tarefas | cor: #1D9E75
  GRUPO Entregas do mes
    tarefa: Relatorio mensal = concluido
    tarefa: Apresentacao diretoria = pendente
    tarefa: Planilha consolidada = concluido | nota: enviada por email
  GRUPO Proximas acoes
    tarefa: Revisar contrato = pendente
    tarefa: Agendar reuniao = pendente
  GRAFICO pizza | dados: Entregas do mes, Proximas acoes

CARD Exemplo Fases | cor: #378ADD
  GRUPO Pipeline
    fase: Modulo A = entregue
    fase: Modulo B = em andamento
    fase: Modulo C = planejado
    fase: Modulo D = cancelado
  GRAFICO pizza | dados: Pipeline

CARD Exemplo Numeros | cor: #BA7517
  GRUPO Producao Anual
    producao: 2021 = 800
    producao: 2022 = 1200
    producao: 2023 = 1450
    producao: 2024 = 1380
  GRAFICO barras | dados: Producao Anual

CARD Exemplo Linha | cor: #7F77DD
  GRUPO Evolucao Mensal
    producao: Jan = 100
    producao: Fev = 130
    producao: Mar = 125
    producao: Abr = 160
    producao: Mai = 155
    producao: Jun = 180
  GRAFICO linhas | dados: Evolucao Mensal`;
}

/* ══════════════════════════════════════════
   AÇÕES
   ══════════════════════════════════════════ */

function createFromScratch() {
  const data = {
    marca: 'Marca',
    titulo: 'Novo Dashboard',
    subtitulo: 'Subtitulo',
    tipos: {},
    cabecalho: [],
    cards: []
  };
  dataSnapshot = JSON.parse(JSON.stringify(data));
  dashboardData = data;
  editMode = true;
  viewMode = false;
  updateModeUI();
  renderDashboard(dashboardData);
}

function downloadTemplate() {
  const blob = new Blob([generateTemplate()], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'template_dashboard.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt';
  input.onchange = function(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(ev) {
      if (editMode || viewMode) {
        editMode = false;
        viewMode = false;
        dataSnapshot = null;
        updateModeUI();
      }
      const data = parseTXT(ev.target.result);
      renderDashboard(data);
    };
    reader.readAsText(file);
  };
  input.click();
}

function resetDashboard() {
  destroyCharts();
  dashboardData = null;
  dataSnapshot = null;
  editMode = false;
  viewMode = false;
  updateModeUI();
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('empty-state').classList.remove('hidden');
}

function downloadEditedTXT() {
  const txt = exportTXT(dashboardData);
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (dashboardData.titulo || 'dashboard') + '.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── PDF helpers ── */
const _PDF_THEME = {
  light: {
    bg: null, cardFill: null,
    text: '#334155', brand: '#94A3B8', titulo: '#0F172A', subtitulo: '#64748B',
    cardTitle: '#0F172A', groupLabel: '#94A3B8', itemName: '#334155', itemVal: '#64748B',
    kpiLabel: '#94A3B8', kpiValue: '#0F172A', kpiSub: '#64748B', kpiSubLabel: '#64748B', kpiSubVal: '#334155',
    divider: '#E2E8F0', chartTick: '#64748B', chartGrid: '#E2E8F0', chartBg: null
  },
  dark: {
    bg: '#0F172A', cardFill: '#1E293B',
    text: '#CBD5E1', brand: '#64748B', titulo: '#F8FAFC', subtitulo: '#94A3B8',
    cardTitle: '#F1F5F9', groupLabel: '#64748B', itemName: '#CBD5E1', itemVal: '#94A3B8',
    kpiLabel: '#64748B', kpiValue: '#F8FAFC', kpiSub: '#94A3B8', kpiSubLabel: '#94A3B8', kpiSubVal: '#CBD5E1',
    divider: '#334155', chartTick: '#94A3B8', chartGrid: '#334155', chartBg: '#1E293B'
  }
};

function _pdfChartCfg(tipo, chartData, th) {
  const silent = { animation: false, responsive: false, plugins: { legend: { display: false } } };
  const tick = { color: th.chartTick, font: { size: 9 } };
  const grid = { color: th.chartGrid };
  const pieBorder = th.chartBg || '#ffffff';
  if (tipo === 'pizza') return {
    type: 'pie',
    data: { labels: chartData.labels, datasets: [{ data: chartData.values, backgroundColor: chartData.colors, borderColor: pieBorder, borderWidth: 2 }] },
    options: silent
  };
  if (tipo === 'barras') return {
    type: 'bar',
    data: { labels: chartData.labels, datasets: [{ data: chartData.values, backgroundColor: chartData.colors, borderRadius: 3 }] },
    options: { ...silent, scales: { x: { ticks: tick, grid: { display: false } }, y: { ticks: tick, grid } } }
  };
  const multi = chartData.datasets.length > 1;
  return {
    type: 'line',
    data: {
      labels: chartData.labels,
      datasets: chartData.datasets.map(ds => ({
        label: ds.label, data: ds.values,
        borderColor: ds.color, backgroundColor: ds.color + '30',
        fill: !multi, tension: 0.3, pointRadius: 3, spanGaps: true
      }))
    },
    options: {
      ...silent,
      plugins: { legend: { display: multi, labels: { color: th.chartTick, font: { size: 9 } } } },
      scales: { x: { ticks: tick, grid: { display: false } }, y: { ticks: tick, grid } }
    }
  };
}

function _pdfChartImg(tipo, chartData, th) {
  const canvas = document.createElement('canvas');
  canvas.width = 280; canvas.height = 240;
  if (th.chartBg) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = th.chartBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const chart = new Chart(canvas, _pdfChartCfg(tipo, chartData, th));
  const dataUrl = canvas.toDataURL('image/png');
  chart.destroy();
  return dataUrl;
}

function _pdfKpiBlock(kpi, data) {
  const val = String(calcKPI(kpi, data));
  const subs = (data.cabecalho || []).filter(k => k.incluir === kpi.label);
  const stack = [
    { text: (kpi.label || '').toUpperCase(), style: 'kpiLabel' },
    { text: val, style: 'kpiValue', marginTop: 2 }
  ];
  if (kpi.sub) stack.push({ text: kpi.sub, style: 'kpiSub', marginTop: 1 });
  if (subs.length) stack.push({
    table: {
      widths: ['*', 'auto'],
      body: subs.map(s => [
        { text: s.label, style: 'kpiSubLabel', border: [false,false,false,false] },
        { text: String(calcKPI(s, data)), style: 'kpiSubVal', border: [false,false,false,false] }
      ])
    },
    layout: 'noBorders', marginTop: 4
  });
  return { stack };
}

function _pdfCardBlock(card, chartImgs, th) {
  const tipos = dashboardData.tipos;
  const itemsStack = [];
  for (const grupo of card.grupos) {
    if (!grupo.itens.length) continue;
    if (itemsStack.length) itemsStack.push({ text: '', margin: [0, 4, 0, 0] });
    itemsStack.push({ text: grupo.nome.toUpperCase(), style: 'groupLabel' });
    for (const item of grupo.itens) {
      const tipo = tipos[item.tipo];
      let dot = '#94A3B8';
      let valText = item.valor;
      if (tipo?.tipo === 'enum') {
        const e = tipo.estados.find(e => e.nome === item.valor);
        if (e) dot = e.cor;
      } else if (tipo?.tipo === 'numero') {
        valText = item.valor + (tipo.unidade ? ' ' + tipo.unidade : '');
      }
      itemsStack.push({
        columns: [
          { canvas: [{ type: 'rect', x: 0, y: 2.5, w: 5, h: 5, r: 1, color: dot }], width: 9 },
          { text: item.nome, style: 'itemName', width: '*' },
          { text: valText, style: 'itemVal', width: 'auto' }
        ],
        columnGap: 3, marginBottom: 2
      });
    }
  }

  const chartsCol = chartImgs.length
    ? { stack: chartImgs.map(img => ({ image: img, width: 128, margin: [0, 0, 0, 4] })), width: 134 }
    : null;
  const itemsCol = itemsStack.length ? { stack: itemsStack, width: '*' } : { text: '', width: '*' };

  return {
    table: {
      widths: ['*'],
      body: [[{
        stack: [
          { text: card.nome, style: 'cardTitle', marginBottom: 5 },
          chartsCol ? { columns: [chartsCol, itemsCol], columnGap: 6 } : itemsCol
        ],
        margin: [8, 6, 8, 8]
      }]]
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: (i) => i === 0 ? 3 : 0,
      vLineColor: () => card.cor || '#378ADD',
      fillColor: () => th.cardFill
    },
    marginBottom: 8
  };
}

function _gerarPDF(darkTheme) {
  const btn = document.getElementById('btn-pdf');
  btn.textContent = 'Gerando...';
  btn.disabled = true;

  try {
    const th = darkTheme ? _PDF_THEME.dark : _PDF_THEME.light;
    const data = dashboardData;

    const cardChartImgs = data.cards.map(card =>
      (card.graficos || []).map(g => _pdfChartImg(g.tipo, collectChartData(card, g, data.tipos), th))
    );

    const topKpis = (data.cabecalho || []).filter(k => !k.incluir);
    const kpiCols = topKpis.map(k => _pdfKpiBlock(k, data));

    const cardRows = [];
    for (let i = 0; i < data.cards.length; i += 2) {
      const left  = _pdfCardBlock(data.cards[i],     cardChartImgs[i],     th);
      const right = i + 1 < data.cards.length
        ? _pdfCardBlock(data.cards[i + 1], cardChartImgs[i + 1], th)
        : { text: '' };
      cardRows.push({ columns: [left, right], columnGap: 10, marginBottom: 4 });
    }

    const divider = {
      table: { widths: ['*'], body: [[{ text: '', border: [false,false,false,false] }]] },
      layout: { hLineWidth: (i) => i === 1 ? 0.5 : 0, vLineWidth: () => 0, hLineColor: () => th.divider, paddingTop: () => 0, paddingBottom: () => 0, paddingLeft: () => 0, paddingRight: () => 0 },
      margin: [0, 4, 0, 8]
    };

    const docDef = {
      pageOrientation: 'landscape',
      pageSize: 'A4',
      pageMargins: [24, 24, 24, 24],
      defaultStyle: { font: 'Roboto', fontSize: 9, color: th.text },
      content: [
        {
          columns: [{
            stack: [
              { text: [{ text: data.marca ? data.marca + '  ' : '', style: 'brand' }, { text: data.titulo || '', style: 'titulo' }] },
              { text: data.subtitulo || '', style: 'subtitulo', marginTop: 1 }
            ], width: '*'
          }], marginBottom: 6
        },
        divider,
        ...(kpiCols.length ? [{ columns: kpiCols, columnGap: 8, marginBottom: 10 }, divider] : []),
        ...cardRows
      ],
      styles: {
        brand:       { fontSize: 8, bold: true, color: th.brand },
        titulo:      { fontSize: 13, bold: true, color: th.titulo },
        subtitulo:   { fontSize: 9, color: th.subtitulo },
        cardTitle:   { fontSize: 10, bold: true, color: th.cardTitle },
        groupLabel:  { fontSize: 7, bold: true, color: th.groupLabel },
        itemName:    { fontSize: 8, color: th.itemName },
        itemVal:     { fontSize: 8, color: th.itemVal },
        kpiLabel:    { fontSize: 7, bold: true, color: th.kpiLabel },
        kpiValue:    { fontSize: 17, bold: true, color: th.kpiValue },
        kpiSub:      { fontSize: 8, color: th.kpiSub },
        kpiSubLabel: { fontSize: 8, color: th.kpiSubLabel },
        kpiSubVal:   { fontSize: 8, bold: true, color: th.kpiSubVal }
      }
    };

    if (darkTheme) {
      docDef.background = (currentPage, pageSize) => ({
        canvas: [{ type: 'rect', x: 0, y: 0, w: pageSize.width, h: pageSize.height, color: th.bg }]
      });
    }

    const title = (data.titulo || 'dashboard').replace(/\s+/g, '_').toLowerCase();
    pdfMake.createPdf(docDef).download(title + '.pdf');

  } catch (err) {
    console.error('Erro ao gerar PDF:', err);
    alert('Erro ao gerar PDF: ' + err.message);
  } finally {
    btn.textContent = 'Exportar PDF';
    btn.disabled = false;
  }
}

function exportPDF() {
  const btn = document.getElementById('btn-pdf');
  const html = buildPopoverOptions('Tema do PDF', [
    { value: 'light', label: 'Fundo claro', desc: 'Branco — ideal para impressão' },
    { value: 'dark',  label: 'Fundo escuro', desc: 'Igual ao modo noturno' }
  ]);
  showPopover(btn, html, function(e) {
    const opt = e.target.closest('.edit-popover-option');
    if (!opt) return;
    removePopover();
    _gerarPDF(opt.dataset.value === 'dark');
  });
}

/* ══════════════════════════════════════════
   TEMA
   ══════════════════════════════════════════ */

function isDark() {
  return document.documentElement.classList.contains('dark');
}

function updateThemeBtn() {
  document.getElementById('theme-btn').textContent = isDark() ? '☼' : '☾';
}

function toggleTheme() {
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', isDark() ? 'dark' : 'light');
  updateThemeBtn();
  if (dashboardData) renderDashboard(dashboardData);
}

(function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark' || (!saved && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
  updateThemeBtn();
})();

/* ══════════════════════════════════════════
   SETUP
   ══════════════════════════════════════════ */

document.getElementById('attr-grid').addEventListener('click', handleGridClick);
document.getElementById('kpi-row').addEventListener('click', handleKpiClick);
document.getElementById('dashboard-header').addEventListener('click', handleHeaderClick);
document.getElementById('modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
