/* ── Estado global ── */
let dashboardData = null;
let editMode = false;
let viewMode = false;
let dataSnapshot = null;

/* ══════════════════════════════════════════
   PARSER
   ══════════════════════════════════════════ */

function parseTXT(text) {
  const lines = text.split(/\r?\n/);
  const data = { titulo: '', marca: '', subtitulo: '', raizes: {}, cabecalho: [], cards: [] };
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
        data.raizes[name] = { tipo: 'enum', estados };
      } else {
        data.raizes[name] = { tipo: 'numero', unidade: body.trim() };
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
      const raiz = line.slice(0, colonIdx).trim();
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
      currentGroup.itens.push({ raiz, nome, valor, nota });
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

  for (const [name, raiz] of Object.entries(data.raizes)) {
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
        let line = '    ' + item.raiz + ': ' + item.nome + ' = ' + item.valor;
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
      const raiz = raizes[item.raiz];
      if (!raiz || raiz.tipo !== 'enum') continue;
      if (!contagem[item.valor]) contagem[item.valor] = 0;
      contagem[item.valor]++;
      const estado = raiz.estados.find(e => e.nome === item.valor);
      if (estado) cores[item.valor] = estado.cor;
    }
    return { labels: Object.keys(contagem), values: Object.values(contagem), colors: Object.keys(contagem).map(k => cores[k] || '#94A3B8') };
  }

  if (grafico.tipo === 'barras' || grafico.tipo === 'linhas') {
    const firstRaiz = itens[0] ? raizes[itens[0].raiz] : null;
    if (firstRaiz?.tipo === 'enum') {
      const contagem = {};
      const cores = {};
      for (const item of itens) {
        const raiz = raizes[item.raiz];
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
      const raiz = raizes[item.raiz];
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

function destroyCharts() {
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
        const rmChild = editMode ? '<button class="edit-action-remove" data-action="remove-kpi" data-kpi-idx="' + ch.idx + '" style="margin-left:auto">&times;</button>' : '';
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
    const stats = getCardStats(card, data.raizes);
    const el = document.createElement('div');
    el.className = 'attr-card';

    const rmCard = editMode ? ' <button class="edit-action-remove" data-action="remove-card" data-card-idx="' + ci + '" title="Remover card">&times;</button>' : '';
    let headerHTML = '<div class="attr-header">' +
      '<div class="attr-name"><div class="attr-accent" style="background:' + card.cor + '"></div>' +
      '<span data-editable="card-name" data-card-idx="' + ci + '">' + esc(card.nome) + '</span>' + rmCard + '</div>' +
      '<div class="attr-stats"><div class="attr-count">' + stats.total + ' itens</div></div></div>';

    let bodyHTML = '<div class="attr-body">';

    // Graficos
    if (card.graficos.length > 0) {
      bodyHTML += '<div class="chart-col">';
      for (let gri = 0; gri < card.graficos.length; gri++) {
        const grafico = card.graficos[gri];
        const cid = 'chart-' + (canvasId++);
        bodyHTML += '<div class="chart-wrap"><canvas id="' + cid + '"></canvas></div>';
        if (editMode) {
          bodyHTML += '<div class="chart-edit-actions">' +
            '<button class="edit-action-small" data-editable="chart-type" data-card-idx="' + ci + '" data-chart-idx="' + gri + '">' + grafico.tipo + '</button>' +
            '<button class="edit-action-small" data-editable="chart-data" data-card-idx="' + ci + '" data-chart-idx="' + gri + '">dados</button>' +
            '</div>';
        }
        const chartData = collectChartData(card, grafico, data.raizes);
        bodyHTML += '<div class="chart-legend">';
        for (let i = 0; i < chartData.labels.length; i++) {
          bodyHTML += '<div class="legend-row"><span style="display:flex;align-items:center;gap:4px"><span class="legend-dot" style="background:' + chartData.colors[i] + '"></span>' + esc(chartData.labels[i]) + '</span><span style="font-weight:500">' + chartData.values[i] + '</span></div>';
        }
        bodyHTML += '</div>';
        setTimeout(() => renderChart(cid, grafico.tipo, chartData), 0);
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
        const raiz = data.raizes[item.raiz];
        let statusIcon = '○';
        let statusStyle = 'background:var(--pend-bg);color:var(--pend-text)';

        if (raiz?.tipo === 'enum') {
          const estado = raiz.estados.find(e => e.nome === item.valor);
          if (estado) {
            statusStyle = 'background:' + estado.cor + '20;color:' + estado.cor;
          }
          if (raiz.estados.length > 0 && item.valor === raiz.estados[0].nome) {
            statusIcon = '✓';
          }
        } else if (raiz?.tipo === 'numero') {
          statusStyle = 'background:var(--surface2);color:var(--text3)';
          statusIcon = '#';
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
    config = {
      type: 'line',
      data: { labels: chartData.labels, datasets: [{ data: chartData.values, borderColor: chartData.colors[0] || '#378ADD', backgroundColor: (chartData.colors[0] || '#378ADD') + '20', fill: true, tension: 0.3, pointRadius: 4, pointBackgroundColor: chartData.colors[0] || '#378ADD' }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: textColor, font: { size: 10 } }, grid: { display: false } }, y: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } } } }
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
  if (viewMode) footer += '<button class="btn" onclick="backToEdit()">Voltar a editar</button>';
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
  pop.style.top = (rect.bottom + 4) + 'px';
  pop.style.left = rect.left + 'px';
  pop.style.maxHeight = Math.max(120, window.innerHeight - rect.bottom - 16) + 'px';
  requestAnimationFrame(() => {
    const pr = pop.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8) pop.style.left = Math.max(8, window.innerWidth - pr.width - 8) + 'px';
  });
  if (onClick) pop.addEventListener('click', onClick);
  activePopover = pop;
  popoverDismissHandler = function(e) {
    if (!pop.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) removePopover();
  };
  setTimeout(() => document.addEventListener('click', popoverDismissHandler), 0);
}

function removePopover() {
  if (activePopover) { activePopover.remove(); activePopover = null; }
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
  const raiz = dashboardData.raizes[item.raiz];
  if (!raiz || raiz.tipo !== 'enum') return;
  let html = '';
  for (const estado of raiz.estados) {
    const sel = item.valor === estado.nome ? ' selected' : '';
    html += '<div class="edit-popover-option' + sel + '" data-value="' + esc(estado.nome) + '">' +
      '<span class="legend-dot" style="background:' + estado.cor + '"></span>' + esc(estado.nome) + '</div>';
  }
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
  const tipos = [
    { v: 'pizza', l: 'Pizza', d: 'Ideal para dados categoricos (enum)' },
    { v: 'barras', l: 'Barras', d: 'Ideal para valores numericos' },
    { v: 'linhas', l: 'Linhas', d: 'Ideal para series temporais/evolucao' }
  ];
  let html = '';
  for (const t of tipos) {
    const sel = grafico.tipo === t.v ? ' selected' : '';
    html += '<div class="edit-popover-option' + sel + '" data-value="' + t.v + '"><div><strong>' + t.l + '</strong><br><span style="font-size:10px;color:var(--text3)">' + t.d + '</span></div></div>';
  }
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
  let html = '<div class="popover-title">Grupos de dados</div>';
  for (let gi = 0; gi < card.grupos.length; gi++) {
    const nome = card.grupos[gi].nome;
    const chk = grafico.gruposRef.includes(nome) ? ' checked' : '';
    html += '<label class="popover-check"><input type="checkbox" data-grupo="' + gi + '"' + chk + '> ' + esc(nome) + '</label>';
  }
  html += '<div class="popover-actions"><button class="btn popover-btn" data-action="confirm">Confirmar</button></div>';
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
  for (const raiz of Object.values(dashboardData.raizes))
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
    const raiz = dashboardData.raizes[raizName];
    const def = raiz.tipo === 'enum' ? (raiz.estados[0]?.nome || '') : '0';
    grupo.itens.push({ raiz: raizName, nome: 'Novo item', valor: def, nota: '' });
    renderDashboard(dashboardData);
    return;
  }
  const raizNames = Object.keys(dashboardData.raizes);
  let html = '<div class="popover-title">Tipo do item</div>';
  for (const name of raizNames) {
    const raiz = dashboardData.raizes[name];
    const desc = raiz.tipo === 'enum' ? 'enum (' + raiz.estados.map(e => e.nome).join(', ') + ')' : 'numero (' + raiz.unidade + ')';
    html += '<div class="edit-popover-option" data-value="' + esc(name) + '"><div><strong>' + esc(name) + '</strong><br><span style="font-size:10px;color:var(--text3)">' + esc(desc) + '</span></div></div>';
  }
  html += '<div class="edit-popover-option popover-option-create" data-action="create-raiz">+ Criar novo TIPO</div>';
  showPopover(anchorEl, html, function(e) {
    const opt = e.target.closest('.edit-popover-option');
    if (!opt) return;
    if (opt.dataset.action === 'create-raiz') {
      removePopover();
      openCreateRaizPopover(anchorEl, function(raizName) {
        const raiz = dashboardData.raizes[raizName];
        const def = raiz.tipo === 'enum' ? (raiz.estados[0]?.nome || '') : '0';
        grupo.itens.push({ raiz: raizName, nome: 'Novo item', valor: def, nota: '' });
        renderDashboard(dashboardData);
      });
      return;
    }
    const raizName = opt.dataset.value;
    if (!raizName) return;
    const raiz = dashboardData.raizes[raizName];
    const def = raiz.tipo === 'enum' ? (raiz.estados[0]?.nome || '') : '0';
    grupo.itens.push({ raiz: raizName, nome: 'Novo item', valor: def, nota: '' });
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

function openCreateRaizPopover(anchorEl, callback) {
  let html = '<div class="popover-title">Novo TIPO</div>' +
    '<div class="popover-form">' +
    '<input type="text" class="inline-edit popover-input" placeholder="Nome (ex: tarefa)" data-field="raiz-name">' +
    '<div class="popover-radios">' +
    '<label><input type="radio" name="raiz-tipo" value="enum" checked> Enum</label>' +
    '<label><input type="radio" name="raiz-tipo" value="numero"> Numero</label>' +
    '</div>' +
    '<div data-container="raiz-config">' +
    '<input type="text" class="inline-edit popover-input" placeholder="estado1: #cor1, estado2: #cor2" data-field="raiz-estados">' +
    '</div>' +
    '<button class="btn popover-btn" data-action="create-raiz">Criar</button>' +
    '</div>';

  showPopover(anchorEl, html, function(e) {
    const pop = e.target.closest('.edit-popover');
    if (!pop) return;

    if (e.target.name === 'raiz-tipo') {
      const container = pop.querySelector('[data-container="raiz-config"]');
      container.innerHTML = e.target.value === 'enum'
        ? '<input type="text" class="inline-edit popover-input" placeholder="estado1: #cor1, estado2: #cor2" data-field="raiz-estados">'
        : '<input type="text" class="inline-edit popover-input" placeholder="Unidade (ex: ton, R$, %)" data-field="raiz-unidade">';
    }

    if (e.target.closest('[data-action="create-raiz"]')) {
      const name = pop.querySelector('[data-field="raiz-name"]')?.value.trim();
      if (!name) return;
      const tipo = pop.querySelector('input[name="raiz-tipo"]:checked').value;
      if (tipo === 'enum') {
        const str = pop.querySelector('[data-field="raiz-estados"]')?.value.trim();
        if (!str) return;
        const estados = str.split(',').map(s => s.trim()).map(s => {
          const m = s.match(/^(.+):\s*(#[0-9A-Fa-f]{3,8})$/);
          return m ? { nome: m[1].trim(), cor: m[2] } : null;
        }).filter(Boolean);
        if (estados.length === 0) return;
        dashboardData.raizes[name] = { tipo: 'enum', estados };
      } else {
        dashboardData.raizes[name] = { tipo: 'numero', unidade: pop.querySelector('[data-field="raiz-unidade"]')?.value.trim() || '' };
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
    if (action === 'remove-card') removeCard(ci);
    else if (action === 'remove-group') removeGroup(ci, gi);
    else if (action === 'remove-item') removeItem(ci, gi, ii);
    else if (action === 'add-item') addItem(ci, gi, actionEl);
    else if (action === 'add-group') addGroup(ci);
    else if (action === 'add-card') addCard();
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

function exportPDF() {
  window.print();
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
