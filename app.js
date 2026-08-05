/**
 * Conferência de Plantel — lógica principal
 * -------------------------------------------
 * - Guarda o Plantel inteiro em IndexedDB (cache offline)
 * - Busca local (instantânea, funciona sem internet)
 * - Fila de sincronização para leituras feitas offline
 * - Trata registros de LOTE (Estoque > 1) exigindo confirmação
 */

// ===== MARCA — único bloco que muda entre as cópias de cada criador =====
// Troque nome, logo e cores aqui para personalizar uma cópia específica.
// Se logoUrl ficar em branco, o app mostra só o texto do nome mesmo.
const MARCA = {
  nomeApp: 'Eco Park Sol & Mar',
  logoUrl: './logo.png',
  corPrimaria: '#2c6b80',
  corSecundaria: '#e0a72e'
};

function aplicarMarca_() {
  document.documentElement.style.setProperty('--verde', MARCA.corPrimaria);
  document.documentElement.style.setProperty('--ambar', MARCA.corSecundaria);
  document.title = MARCA.nomeApp;

  const titulo = document.getElementById('tituloApp');
  if (titulo) titulo.textContent = MARCA.nomeApp;

  const logo = document.getElementById('logoMarca');
  if (logo && MARCA.logoUrl) {
    logo.src = MARCA.logoUrl;
    logo.style.display = 'inline-block';
  }

  const logoGrande = document.getElementById('logoGrande');
  if (logoGrande && MARCA.logoUrl) {
    logoGrande.src = MARCA.logoUrl;
  }
}

// ===== IndexedDB — wrapper mínimo em Promises =====

const DB_NOME = 'plantelDB_ecopark';
const DB_VERSAO = 2; // v2: chave de 'animais' passou de identificacao para linha

function dbAbrir() {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open(DB_NOME, DB_VERSAO);
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'chave' });
      }
      // Recria 'animais' do zero — bancos criados antes da v2 usavam o
      // código do chip como chave, o que quebrava com microchips
      // duplicados (um sobrescrevia o outro). A chave agora é a linha
      // da planilha, sempre única mesmo com chip repetido.
      if (db.objectStoreNames.contains('animais')) {
        db.deleteObjectStore('animais');
      }
      db.createObjectStore('animais', { keyPath: 'linha' });
      if (!db.objectStoreNames.contains('fila')) {
        db.createObjectStore('fila', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

let DB;

function dbGet(store, chave) {
  return new Promise(function (resolve, reject) {
    const tx = DB.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(chave);
    req.onsuccess = function () { resolve(req.result || null); };
    req.onerror = function () { reject(req.error); };
  });
}

function dbGetAll(store) {
  return new Promise(function (resolve, reject) {
    const tx = DB.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = function () { resolve(req.result || []); };
    req.onerror = function () { reject(req.error); };
  });
}

function dbPut(store, valor) {
  return new Promise(function (resolve, reject) {
    const tx = DB.transaction(store, 'readwrite');
    tx.objectStore(store).put(valor);
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

function dbClear(store) {
  return new Promise(function (resolve, reject) {
    const tx = DB.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

function dbDelete(store, chave) {
  return new Promise(function (resolve, reject) {
    const tx = DB.transaction(store, 'readwrite');
    tx.objectStore(store).delete(chave);
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

function dbBulkPut(store, valores) {
  return new Promise(function (resolve, reject) {
    const tx = DB.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    valores.forEach(function (v) { os.put(v); });
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

// ===== Configuração (URL da Web App, token, técnico) =====

// URL fixa da Web App — fica sempre a mesma enquanto você atualizar por
// "Nova versão" na mesma implantação (só muda se criar uma implantação
// nova do zero). Assim o operador só precisa preencher token + nome.
const URL_PADRAO = 'https://script.google.com/macros/s/AKfycbxnC5Oz3K5BnouWtakBgRBWpmMb55F0FC_ymjmNQsfJWw7QY5cdd2biEzw6WtrY3HIoqg/exec';

let CONFIG = { apiUrl: URL_PADRAO, apiToken: '', tecnico: '' };

async function carregarConfig() {
  const chaves = ['apiUrl', 'apiToken', 'tecnico'];
  for (const chave of chaves) {
    const item = await dbGet('config', chave);
    if (item) CONFIG[chave] = item.valor;
  }
}

async function salvarConfig(apiUrl, apiToken, tecnico) {
  CONFIG = { apiUrl: apiUrl.trim(), apiToken: apiToken.trim(), tecnico: tecnico.trim() };
  await dbPut('config', { chave: 'apiUrl', valor: CONFIG.apiUrl });
  await dbPut('config', { chave: 'apiToken', valor: CONFIG.apiToken });
  await dbPut('config', { chave: 'tecnico', valor: CONFIG.tecnico });
}

function configCompleta() {
  return !!(CONFIG.apiUrl && CONFIG.apiToken && CONFIG.tecnico);
}

// ===== Chamadas à Web App =====

async function apiGet(action) {
  const url = CONFIG.apiUrl + '?action=' + action + '&token=' + encodeURIComponent(CONFIG.apiToken);
  const resp = await fetch(url);
  const dados = await resp.json();
  if (dados.erro) throw new Error(dados.erro);
  return dados;
}

// Content-Type text/plain de propósito — evita o preflight OPTIONS que o
// Apps Script não trata bem, permitindo a chamada cross-origin funcionar.
async function apiPost(corpo) {
  corpo.token = CONFIG.apiToken;
  const resp = await fetch(CONFIG.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(corpo)
  });
  const dados = await resp.json();
  if (dados.erro) throw new Error(dados.erro);
  return dados;
}

// ===== Sincronização do cache completo do Plantel =====

function encontrarChipsDuplicados_(animais) {
  const vistos = {};
  const duplicados = [];
  animais.forEach(function (a) {
    const id = a.identificacao;
    if (!id) return;
    if (vistos[id]) {
      duplicados.push(id);
    } else {
      vistos[id] = true;
    }
  });
  return duplicados;
}

async function atualizarCacheCompleto(forcar) {
  if (!forcar) {
    const fila = await dbGetAll('fila');
    if (fila.length > 0) {
      const seguir = window.confirm(
        'Ainda há ' + fila.length + ' leitura(s) desta fiscalização aguardando sincronização.\n\n' +
        'Se você atualizar o cache agora (por exemplo, para a próxima fiscalização), ' +
        'essas leituras pendentes vão ficar órfãs e não vão ser gravadas em lugar nenhum.\n\n' +
        'Toque em "Cancelar" e use "Sincronizar agora" primeiro, ou "OK" para descartar essas ' +
        'leituras pendentes e seguir mesmo assim.'
      );
      if (!seguir) return -1;
      await dbClear('fila');
    }
  }

  definirStatusSync('Baixando plantel...');
  const dados = await apiGet('listarPlantel');
  const duplicados = encontrarChipsDuplicados_(dados.animais);
  await dbClear('animais');
  await dbBulkPut('animais', dados.animais);
  await dbPut('config', { chave: 'ultimaSincronizacao', valor: dados.atualizadoEm });
  definirStatusSync('ok');
  await atualizarContadoresLocais();

  if (duplicados.length > 0) {
    mostrarAvisoTopo(
      'ATENÇÃO: ' + duplicados.length + ' microchip(s) duplicado(s) no plantel (ex: ' + duplicados[0] + '). ' +
      'A busca vai mostrar uma lista pra você escolher manualmente — mas o correto é corrigir a duplicidade na origem.',
      'erro'
    );
  }

  return dados.animais.length;
}

// ===== Contadores locais (a partir do cache, funciona offline) =====

async function atualizarContadoresLocais() {
  const animais = await dbGetAll('animais');
  let totalAnimais = 0, animaisVerificados = 0, animaisDivergencias = 0;
  animais.forEach(function (a) {
    const estoque = Number(a.estoque) || 1;

    if (a.origem === 'anomalia') {
      // Registro de "não localizado" — não é um animal real do plantel,
      // não entra no Total, só em Divergências.
      animaisDivergencias += estoque;
      return;
    }

    totalAnimais += estoque;
    if (a.status === 'Verificado') {
      animaisVerificados += estoque;
    } else if (a.status === 'Divergente') {
      animaisDivergencias += estoque;
    }
  });
  const animaisPendentes = totalAnimais - animaisVerificados - animaisDivergencias;
  const percentual = totalAnimais > 0 ? Math.round((animaisVerificados / totalAnimais) * 1000) / 10 : 0;

  document.getElementById('ctdTotal').textContent = totalAnimais;
  document.getElementById('ctdVerificados').textContent = animaisVerificados;
  document.getElementById('ctdDivergencias').textContent = animaisDivergencias;
  document.getElementById('ctdPendentes').textContent = animaisPendentes;
  document.getElementById('ctdPercentual').textContent = percentual + '%';
  document.getElementById('barraProgresso').style.width = percentual + '%';

  const fila = await dbGetAll('fila');
  document.getElementById('filaContagem').textContent = fila.length;
  document.getElementById('blocoFila').style.display = fila.length > 0 ? 'flex' : 'none';
}

// ===== Busca local =====

async function buscarLocal(termo) {
  const animais = await dbGetAll('animais');
  const termoLower = termo.trim();
  return animais.filter(function (a) {
    return String(a.identificacao || '').indexOf(termoLower) !== -1;
  });
}

// ===== Fluxo de conferência (marcar verificado) =====

async function marcarComoVerificado(animal, observacoes) {
  const online = navigator.onLine;

  if (online) {
    try {
      const resultado = await apiPost({
        action: 'marcarVerificado',
        codigo: animal.identificacao,
        tecnico: CONFIG.tecnico,
        observacoes: observacoes || ''
      });
      await aplicarStatusLocal(animal, 'Verificado');
      await atualizarContadoresLocais();
      return { sucesso: true, sincronizado: true, resultado: resultado };
    } catch (err) {
      // Falhou mesmo online (ex: rede instável no meio do envio) — cai
      // para o fluxo offline abaixo em vez de perder a leitura.
      console.warn('Falha ao marcar online, enfileirando: ' + err.message);
    }
  }

  // Offline (ou falha de rede): grava localmente e enfileira
  await dbPut('fila', {
    tipo: 'verificado',
    codigo: animal.identificacao,
    tecnico: CONFIG.tecnico,
    observacoes: observacoes || '',
    criadoEm: new Date().toISOString()
  });
  await aplicarStatusLocal(animal, 'Verificado');
  await atualizarContadoresLocais();
  return { sucesso: true, sincronizado: false };
}

// Atualiza o status do animal diretamente no objeto já carregado (evita
// precisar buscar de novo pela identificação, que agora não é mais a
// chave do cache — a chave é a linha da planilha).
async function aplicarStatusLocal(animal, novoStatus) {
  animal.status = novoStatus;
  animal.conferidoPor = CONFIG.tecnico;
  animal.dataHora = new Date().toISOString();
  await dbPut('animais', animal);
}

// Registra em campo um código lido que NÃO existe no cache local do
// plantel — sempre disparado manualmente pelo técnico, com observação
// obrigatória explicando a divergência. Depois de registrar, guarda uma
// cópia local também, para que uma leitura repetida do mesmo código
// mostre "já registrado" em vez de pedir tudo de novo.
async function registrarNaoLocalizado(codigo, observacoes) {
  const online = navigator.onLine;

  if (online) {
    try {
      const resultado = await apiPost({
        action: 'registrarNaoLocalizado',
        codigo: codigo,
        tecnico: CONFIG.tecnico,
        observacoes: observacoes
      });
      await cachearAnomaliaLocal(codigo, observacoes, resultado.linha);
      await atualizarContadoresLocais();
      return { sucesso: true, sincronizado: true };
    } catch (err) {
      console.warn('Falha ao registrar divergência online, enfileirando: ' + err.message);
    }
  }

  // Offline: usa uma chave temporária negativa (nunca colide com uma
  // linha real da planilha) — quando a fila sincronizar depois, o
  // próximo "Atualizar cache" substitui esse registro temporário pelo
  // definitivo, já com a linha real.
  await dbPut('fila', {
    tipo: 'anomalia',
    codigo: codigo,
    tecnico: CONFIG.tecnico,
    observacoes: observacoes,
    criadoEm: new Date().toISOString()
  });
  await cachearAnomaliaLocal(codigo, observacoes, -Date.now());
  await atualizarContadoresLocais();
  return { sucesso: true, sincronizado: false };
}

async function cachearAnomaliaLocal(codigo, observacoes, linha) {
  await dbPut('animais', {
    linha: linha,
    nomeCientifico: '(não consta no plantel do criador)',
    nomePopular: '',
    identificacao: codigo,
    tipoMarcacao: '',
    sexo: '',
    idadeFase: '',
    estoque: 1,
    status: 'Divergente',
    origem: 'anomalia',
    conferidoPor: CONFIG.tecnico,
    dataHora: new Date().toISOString(),
    observacoes: observacoes
  });
}

// ===== Sincronização da fila offline =====

let sincronizando = false;

async function sincronizarFila() {
  if (sincronizando) return;
  if (!navigator.onLine) return;
  if (!configCompleta()) return;

  const fila = await dbGetAll('fila');
  if (fila.length === 0) return;

  sincronizando = true;
  definirStatusSync('Sincronizando ' + fila.length + ' leitura(s)...');

  try {
    const itens = fila.map(function (f) {
      return { tipo: f.tipo || 'verificado', codigo: f.codigo, tecnico: f.tecnico, observacoes: f.observacoes };
    });
    const resultado = await apiPost({ action: 'sincronizarFila', itens: itens, tecnico: CONFIG.tecnico });

    // Remove da fila local só os itens processados com sucesso
    for (let i = 0; i < fila.length; i++) {
      await dbDelete('fila', fila[i].id);
    }

    definirStatusSync('ok');
    await atualizarCacheCompleto(); // realinha o cache com a planilha (fonte da verdade)
    mostrarAvisoTopo(resultado.sucesso + ' de ' + resultado.processados + ' leitura(s) sincronizada(s).', 'sucesso');
  } catch (err) {
    definirStatusSync('erro');
    mostrarAvisoTopo('Falha ao sincronizar: ' + err.message, 'erro');
  } finally {
    sincronizando = false;
  }
}

function definirStatusSync(texto) {
  const el = document.getElementById('statusSync');
  if (texto === 'ok') {
    el.textContent = navigator.onLine ? 'Online' : 'Offline';
    el.className = 'status-sync ' + (navigator.onLine ? 'status-ok' : 'status-offline');
  } else if (texto === 'erro') {
    el.textContent = 'Erro de sincronização';
    el.className = 'status-sync status-erro';
  } else {
    el.textContent = texto;
    el.className = 'status-sync status-carregando';
  }
}

function mostrarAvisoTopo(msg, tipo) {
  const el = document.getElementById('avisoTopo');
  el.textContent = msg;
  el.className = 'aviso-topo aviso-' + tipo + ' visivel';
  const duracao = tipo === 'erro' ? 10000 : 4000;
  setTimeout(function () { el.classList.remove('visivel'); }, duracao);
}

// Transforma um PDF em base64 (vindo da Web App) num download local no
// aparelho — sem depender do Google Drive de ninguém.
function salvarBase64ComoArquivo(base64, nomeArquivo, mimeType) {
  const binario = atob(base64);
  const array = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) array[i] = binario.charCodeAt(i);
  const blob = new Blob([array], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
}

// ===== Importação de plantel direto do app =====
// Mesma lógica de leitura do popup da planilha (Importar_Plantel.gs),
// só que rodando no navegador do tablet em vez do editor do Sheets.

function parseHtmlTablePlantel_(texto) {
  const doc = new DOMParser().parseFromString(texto, 'text/html');
  const trs = doc.querySelectorAll('table tr');
  const dados = [];
  for (let i = 2; i < trs.length; i++) {
    const celulas = trs[i].querySelectorAll('td, th');
    if (celulas.length === 0) continue;
    const linha = [];
    for (let c = 0; c < 10; c++) {
      linha.push(celulas[c] ? celulas[c].textContent.trim() : '');
    }
    if (linha.every(function (v) { return v === ''; })) continue;
    dados.push(linha);
  }
  return dados;
}

function parseCsvPlantel_(texto) {
  const linhasTexto = texto.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
  if (linhasTexto.length < 2) return [];
  const sep = linhasTexto[0].indexOf(';') !== -1 ? ';' : ',';
  const dados = [];
  for (let i = 1; i < linhasTexto.length; i++) {
    const linha = linhasTexto[i].split(sep).map(function (v) {
      return v.trim().replace(/^"|"$/g, '');
    });
    if (linha.every(function (v) { return v === ''; })) continue;
    while (linha.length < 10) linha.push('');
    dados.push(linha.slice(0, 10));
  }
  return dados;
}

async function importarPlantelDoArquivo(arquivo) {
  const texto = await new Promise(function (resolve, reject) {
    const leitor = new FileReader();
    leitor.onload = function (e) { resolve(e.target.result); };
    leitor.onerror = function () { reject(new Error('Não consegui ler o arquivo.')); };
    leitor.readAsText(arquivo, 'ISO-8859-1');
  });

  const linhas = (texto.indexOf('<table') !== -1 || texto.indexOf('<TABLE') !== -1)
    ? parseHtmlTablePlantel_(texto)
    : parseCsvPlantel_(texto);

  if (linhas.length === 0) {
    throw new Error('Não encontrei linhas de dados no arquivo.');
  }

  return await apiPost({ action: 'importarPlantel', linhas: linhas });
}

// ===== Renderização da tela de resultado =====

function renderizarResultado(lista, termoBuscado) {
  const painel = document.getElementById('painelResultado');
  painel.innerHTML = '';

  if (lista.length === 0) {
    renderizarNaoLocalizado(termoBuscado);
    return;
  }

  if (lista.length > 1) {
    const lista_html = lista.map(function (a, i) {
      return '<button class="item-lista" data-idx="' + i + '">' +
        '<strong>' + escapeHtml(a.nomeCientifico || a.nomePopular || '(sem nome)') + '</strong>' +
        '<span>ID: ' + escapeHtml(a.identificacao) + ' — Status: ' + escapeHtml(a.status) + '</span>' +
        '</button>';
    }).join('');
    painel.innerHTML = '<div class="cartao">' +
      '<p class="aviso-ambiguo">⚠ ' + lista.length + ' registros contêm este código (duplicidade) — selecione o correto:</p>' +
      '<div class="lista-selecao">' + lista_html + '</div>' +
      '</div>';
    painel.classList.add('visivel');

    painel.querySelectorAll('.item-lista').forEach(function (btn) {
      btn.addEventListener('click', function () {
        renderizarCartaoAnimal(lista[Number(btn.dataset.idx)]);
      });
    });
    return;
  }

  renderizarCartaoAnimal(lista[0]);
}

// Renderiza o card do animal. Se ainda não estiver verificado, marca
// como verificado automaticamente — a intervenção manual do técnico
// fica reservada só para duplicidade (escolher a linha certa) e para
// código não localizado (renderizarNaoLocalizado).
async function renderizarCartaoAnimal(animal) {
  const painel = document.getElementById('painelResultado');

  function montarHtml(statusTexto, statusClasse, tag) {
    return '<div class="cartao">' +
      '<div class="cartao-header status-' + statusClasse + '">' +
      '<span class="cartao-status">' + escapeHtml(statusTexto) + '</span>' +
      (tag ? '<span class="cartao-tag">' + escapeHtml(tag) + '</span>' : '') +
      '</div>' +
      '<h2>' + escapeHtml(animal.nomeCientifico || '(sem nome científico)') + '</h2>' +
      (animal.nomePopular ? '<p class="nome-popular">' + escapeHtml(animal.nomePopular) + '</p>' : '') +
      '<dl class="dados-animal">' +
      '<dt>Identificação</dt><dd>' + escapeHtml(animal.identificacao) + '</dd>' +
      '<dt>Sexo</dt><dd>' + escapeHtml(animal.sexo || '—') + '</dd>' +
      '<dt>Idade/Fase</dt><dd>' + escapeHtml(animal.idadeFase || '—') + '</dd>' +
      '<dt>Tipo marcação</dt><dd>' + escapeHtml(animal.tipoMarcacao || '—') + '</dd>' +
      '</dl>' +
      '<textarea id="obsCampo" placeholder="Observações (opcional)" class="campo-obs">' + escapeHtml(animal.observacoes || '') + '</textarea>' +
      '<button id="btnSalvarObs" class="botao-secundario">Salvar observação</button>' +
      '</div>';
  }

  function ligarBotaoObs() {
    document.getElementById('btnSalvarObs').addEventListener('click', async function () {
      const btn = document.getElementById('btnSalvarObs');
      btn.disabled = true;
      const obs = document.getElementById('obsCampo').value;
      await marcarComoVerificado(animal, obs);
      btn.disabled = false;
      mostrarAvisoTopo('Observação salva.', 'sucesso');
    });
  }

  // "Pendente" (ou vazio) é o único status que ainda não foi tratado —
  // qualquer outro (Verificado, Divergente, Não Localizado...) já foi
  // processado antes e só precisa ser exibido, sem repetir a ação.
  const jaProcessado = !!animal.status && animal.status !== 'Pendente';

  if (jaProcessado) {
    const dataFormatada = animal.dataHora
      ? new Date(animal.dataHora).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      : '';
    const tag = animal.status === 'Verificado'
      ? 'já conferido'
      : ('já registrado' + (dataFormatada ? ' em ' + dataFormatada : ''));
    const editavel = animal.status === 'Verificado';
    painel.innerHTML = montarHtml(animal.status, slugStatus(animal.status), tag);
    painel.classList.add('visivel');
    if (editavel) {
      ligarBotaoObs();
    } else {
      // Registro de divergência: mostra só leitura, sem botão de editar
      // (evita reabrir/alterar um caso que já foi documentado e enviado).
      const btnObs = document.getElementById('btnSalvarObs');
      if (btnObs) btnObs.remove();
      const campoObs = document.getElementById('obsCampo');
      if (campoObs) campoObs.disabled = true;
    }
    return;
  }

  // Ainda não verificado: mostra o card e já dispara a verificação
  // automática, sem esperar toque em nenhum botão.
  painel.innerHTML = montarHtml('Verificando...', 'pendente', '');
  painel.classList.add('visivel');

  const resultado = await marcarComoVerificado(animal, '');
  animal.status = 'Verificado';
  painel.innerHTML = montarHtml('Verificado', 'verificado', resultado.sincronizado ? 'confirmado' : 'salvo offline');
  ligarBotaoObs();

  mostrarAvisoTopo(
    resultado.sincronizado
      ? 'Verificado automaticamente e sincronizado.'
      : 'Verificado automaticamente — sem conexão, será sincronizado depois.',
    resultado.sincronizado ? 'sucesso' : 'aviso'
  );
  document.getElementById('campoBusca').focus();
}

// Tela de código não localizado — sempre manual, exige observação do
// técnico explicando a divergência antes de registrar.
function renderizarNaoLocalizado(codigo) {
  const painel = document.getElementById('painelResultado');
  painel.innerHTML =
    '<div class="cartao">' +
    '<div class="cartao-header status-nao-localizado"><span class="cartao-status">Não localizado</span></div>' +
    '<p>O código <strong>' + escapeHtml(codigo) + '</strong> não consta no plantel deste criador.</p>' +
    '<p class="aviso-ambiguo">Explique a situação antes de registrar (ex: animal apresentado fisicamente, mas sem registro no sistema).</p>' +
    '<textarea id="obsNaoLocalizado" placeholder="Observação (obrigatória)" class="campo-obs"></textarea>' +
    '<button id="btnRegistrarAnomalia" class="botao-confirmar">Registrar não localizado</button>' +
    '</div>';
  painel.classList.add('visivel');

  document.getElementById('btnRegistrarAnomalia').addEventListener('click', async function () {
    const obs = document.getElementById('obsNaoLocalizado').value.trim();
    if (obs === '') {
      mostrarAvisoTopo('Escreva uma observação antes de registrar.', 'erro');
      return;
    }
    const btn = document.getElementById('btnRegistrarAnomalia');
    btn.disabled = true;
    btn.textContent = 'Registrando...';
    const resultado = await registrarNaoLocalizado(codigo, obs);
    btn.textContent = resultado.sincronizado ? 'Registrado ✔' : 'Salvo offline — sincroniza depois';
    mostrarAvisoTopo(
      resultado.sincronizado ? 'Divergência registrada e sincronizada.' : 'Sem conexão — divergência salva localmente.',
      resultado.sincronizado ? 'sucesso' : 'aviso'
    );
    document.getElementById('campoBusca').focus();
  });
}

function slugStatus(status) {
  return String(status || 'pendente').toLowerCase()
    .replace('ã', 'a').replace('ç', 'c').replace('í', 'i')
    .replace(/\s+/g, '-');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== Inicialização =====

async function iniciar() {
  aplicarMarca_();
  DB = await dbAbrir();
  await carregarConfig();

  if (!configCompleta()) {
    abrirConfiguracoes(true);
  } else {
    document.getElementById('campoBusca').disabled = false;
    document.getElementById('campoBusca').focus();
    const animaisCache = await dbGetAll('animais');
    if (animaisCache.length === 0 && navigator.onLine) {
      try { await atualizarCacheCompleto(); } catch (e) { console.error(e); }
    } else {
      await atualizarContadoresLocais();
    }
  }

  definirStatusSync('ok');

  window.addEventListener('online', function () {
    definirStatusSync('ok');
    sincronizarFila();
  });
  window.addEventListener('offline', function () {
    definirStatusSync('ok');
  });

  setInterval(sincronizarFila, 30000);

  document.getElementById('campoBusca').addEventListener('keydown', async function (e) {
    if (e.key !== 'Enter') return;
    const termo = e.target.value.trim();
    e.target.value = ''; // limpa na hora, pronto pra próxima leitura
    if (termo === '') return;
    const resultados = await buscarLocal(termo);
    renderizarResultado(resultados, termo);
  });

  document.getElementById('btnAtualizarCache').addEventListener('click', async function () {
    try {
      const qtd = await atualizarCacheCompleto();
      if (qtd === -1) return; // usuário cancelou por causa da fila pendente
      mostrarAvisoTopo('Cache atualizado: ' + qtd + ' animais.', 'sucesso');
    } catch (err) {
      mostrarAvisoTopo('Não foi possível atualizar (sem internet?): ' + err.message, 'erro');
    }
  });

  document.getElementById('btnConfig').addEventListener('click', function () { abrirConfiguracoes(false); });
  document.getElementById('btnFecharConfig').addEventListener('click', fecharConfiguracoes);

  document.getElementById('btnGerarRelatorio').addEventListener('click', async function () {
    const btn = document.getElementById('btnGerarRelatorio');
    if (!navigator.onLine) {
      mostrarAvisoTopo('É preciso estar online para gerar o relatório.', 'erro');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Gerando relatório...';
    try {
      const resultado = await apiPost({ action: 'gerarRelatorio' });
      if (resultado.sucesso && resultado.conteudoBase64) {
        salvarBase64ComoArquivo(resultado.conteudoBase64, resultado.nomeArquivo || 'relatorio.pdf', 'application/pdf');
        mostrarAvisoTopo('Relatório gerado — verifique a pasta de downloads do aparelho.', 'sucesso');
      } else {
        mostrarAvisoTopo('Não foi possível gerar o relatório: ' + (resultado.motivo || 'erro desconhecido'), 'erro');
      }
    } catch (err) {
      mostrarAvisoTopo('Falha ao gerar relatório: ' + err.message, 'erro');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Gerar Relatório PDF';
    }
  });
  document.getElementById('formConfig').addEventListener('submit', async function (e) {
    e.preventDefault();
    await salvarConfig(
      document.getElementById('cfgUrl').value,
      document.getElementById('cfgToken').value,
      document.getElementById('cfgTecnico').value
    );
    fecharConfiguracoes();
    document.getElementById('campoBusca').disabled = false;
    try {
      const qtd = await atualizarCacheCompleto();
      mostrarAvisoTopo('Configurado. Cache com ' + qtd + ' animais.', 'sucesso');
    } catch (err) {
      mostrarAvisoTopo('Configuração salva, mas não consegui baixar o plantel agora: ' + err.message, 'erro');
    }
    document.getElementById('campoBusca').focus();
  });

  document.getElementById('btnSincronizarAgora').addEventListener('click', sincronizarFila);

  document.getElementById('btnImportarPlantel').addEventListener('click', function () {
    document.getElementById('arquivoImportar').click();
  });

  document.getElementById('arquivoImportar').addEventListener('change', async function (e) {
    const arquivo = e.target.files[0];
    e.target.value = '';
    if (!arquivo) return;

    if (!navigator.onLine) {
      mostrarAvisoTopo('É preciso estar online para importar um novo plantel.', 'erro');
      return;
    }

    const fila = await dbGetAll('fila');
    if (fila.length > 0) {
      const seguir = window.confirm(
        'Ainda há ' + fila.length + ' leitura(s) aguardando sincronização.\n\n' +
        'Importar agora vai substituir os dados da planilha — essas leituras pendentes ficariam órfãs.\n\n' +
        'Cancele e sincronize primeiro, ou toque OK para importar mesmo assim (descartando a fila).'
      );
      if (!seguir) return;
      await dbClear('fila');
    } else {
      const confirmar = window.confirm(
        'Isso vai substituir TODO o plantel atual da planilha pelo conteúdo desse arquivo.\n\n' +
        'Confirma que já finalizou/exportou o que precisava da fiscalização anterior?'
      );
      if (!confirmar) return;
    }

    mostrarAvisoTopo('Importando plantel...', 'aviso');
    try {
      const resultado = await importarPlantelDoArquivo(arquivo);
      if (resultado.sucesso) {
        mostrarAvisoTopo(
          'Plantel importado: ' + resultado.totalRegistros + ' registro(s), ' + resultado.totalAnimais + ' animal(is).',
          'sucesso'
        );
        await atualizarCacheCompleto(true);
      } else {
        mostrarAvisoTopo('Falha ao importar: ' + (resultado.motivo || 'erro desconhecido'), 'erro');
      }
    } catch (err) {
      mostrarAvisoTopo('Falha ao importar: ' + err.message, 'erro');
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(function (e) { console.warn('SW falhou: ' + e); });
  }
}

function abrirConfiguracoes(primeiraVez) {
  document.getElementById('cfgUrl').value = CONFIG.apiUrl;
  document.getElementById('cfgToken').value = CONFIG.apiToken;
  document.getElementById('cfgTecnico').value = CONFIG.tecnico;
  document.getElementById('btnFecharConfig').style.display = primeiraVez ? 'none' : 'inline-block';
  document.getElementById('modalConfig').classList.add('visivel');
}

function fecharConfiguracoes() {
  document.getElementById('modalConfig').classList.remove('visivel');
}

document.addEventListener('DOMContentLoaded', function () {
  iniciar().catch(function (err) {
    console.error(err);
    definirStatusSync('erro');
    mostrarAvisoTopo(
      'Erro ao iniciar: ' + err.message + '. Se você abriu o arquivo direto (duplo clique), o navegador bloqueia o armazenamento local nesse modo — sirva os arquivos por um servidor local (veja o LEIA-ME) ou publique no GitHub Pages.',
      'erro'
    );
  });
});
