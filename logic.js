// logic.js — regras de negócio do Painel Rede Confia (sem acesso a tela nem a banco).
// Tudo aqui é função pura e tem teste em tests/logic.test.mjs.

export const PAPEIS = {
  admin: 'Administrador',
  diretor: 'Diretor',
  supervisor: 'Supervisor',
  consultor: 'Consultor',
};

export const STATUS = [
  { id: 'novo', nome: 'Novo' },
  { id: 'atendimento', nome: 'Em atendimento' },
  { id: 'proposta', nome: 'Proposta enviada' },
  { id: 'venda', nome: 'Venda fechada' },
  { id: 'perdido', nome: 'Sem venda' },
];

export const TOTAL_INDICACOES = 3;
export const MAX_EXTRAS = 12;

// ---------- texto ----------
export function semAcento(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}
export function limparTexto(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}
export function slug(s) {
  return semAcento(limparTexto(s)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
export function soDigitos(s) {
  return String(s ?? '').replace(/\D/g, '');
}

const PARTICULAS = new Set(['de', 'da', 'do', 'dos', 'das', 'e']);
const CORRECOES_NOME = { uberlandia: 'Uberlândia', para: 'Pará', bh: 'BH' };

export function tituloNome(s) {
  return limparTexto(s)
    .toLowerCase()
    .split(' ')
    .map((p, i) => {
      const chave = semAcento(p);
      if (CORRECOES_NOME[chave] && p.length <= 12) return CORRECOES_NOME[chave];
      if (i > 0 && PARTICULAS.has(p)) return p;
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(' ');
}

// ---------- CPF e telefone ----------
export function normalizarCpf(valor) {
  let d = soDigitos(valor);
  // o Excel come o zero à esquerda quando o CPF vira número
  if (d.length >= 9 && d.length < 11) d = d.padStart(11, '0');
  return d;
}

export function cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf)) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  const digito = (base) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (base.length + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return digito(cpf.slice(0, 9)) === Number(cpf[9]) && digito(cpf.slice(0, 10)) === Number(cpf[10]);
}

export function normalizarTelefone(valor) {
  let d = soDigitos(valor);
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : '';
}

export function formatarCpf(c) {
  return /^\d{11}$/.test(c) ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : String(c ?? '');
}
export function mascararCpf(c) {
  return /^\d{11}$/.test(c) ? `***.${c.slice(3, 6)}.${c.slice(6, 9)}-**` : '';
}
export function formatarTelefone(t) {
  if (!/^\d{10,11}$/.test(t)) return String(t ?? '');
  const ddd = t.slice(0, 2);
  const resto = t.slice(2);
  return `(${ddd}) ${resto.slice(0, resto.length - 4)}-${resto.slice(-4)}`;
}

// ---------- CSV ----------
export function parseCsv(texto) {
  const t = String(texto).replace(/^\uFEFF/, '');
  const primeira = t.split(/\r?\n/, 1)[0] || '';
  const sep = [';', '\t', ','].map((s) => [s, primeira.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const linhas = [];
  let campo = '';
  let linha = [];
  let aspas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (aspas) {
      if (c === '"') {
        if (t[i + 1] === '"') { campo += '"'; i++; } else aspas = false;
      } else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === sep) { linha.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      linha.push(campo); campo = ''; linhas.push(linha); linha = [];
    } else campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas.filter((l) => l.some((c) => String(c).trim() !== ''));
}

// Neutraliza células que o Excel interpretaria como fórmula.
export function neutralizarCsv(valor) {
  const s = String(valor ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
export function linhaCsv(campos) {
  return campos
    .map((c) => {
      const s = neutralizarCsv(c);
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(';');
}

// ---------- importação de leads ----------
export function idLead(produtoId, cpf) {
  return `${produtoId}_${cpf}`;
}

export function detectarColunas(cabecalho) {
  const n = cabecalho.map((c) => semAcento(limparTexto(c)).toLowerCase());
  const usados = new Set();
  const achar = (...regexes) => {
    for (const re of regexes) {
      const i = n.findIndex((c, idx) => re.test(c) && !usados.has(idx));
      if (i >= 0) { usados.add(i); return i; }
    }
    return -1;
  };
  const cpf = achar(/\bcpf\b/);
  const nome = achar(/^(nome|nome completo|nome do cliente|cliente)$/, /^nome/, /cliente/);
  const tel = achar(/^(telefone|celular|fone|whatsapp|telefone hot)$/, /(telefone|fone|celular|whats)/);
  const extras = n.map((c, i) => i).filter((i) => !usados.has(i) && n[i] !== '');
  return { nome, cpf, tel, extras };
}

export function prepararLeads(linhas, { produtoId, loteId, origem, existentes = new Set() }) {
  if (!linhas.length) throw new Error('A planilha está vazia.');
  const cab = linhas[0];
  const col = detectarColunas(cab);
  if (col.nome < 0 || col.cpf < 0) {
    throw new Error('Não encontrei as colunas NOME e CPF na primeira linha da planilha.');
  }
  const extrasUsados = col.extras.slice(0, MAX_EXTRAS);
  const leads = [];
  const ignorados = [];
  const vistos = new Set();
  const resumo = { lidas: 0, validas: 0, cpfInvalido: 0, semNome: 0, duplicadasNoArquivo: 0, jaExistem: 0 };

  for (let i = 1; i < linhas.length; i++) {
    const l = linhas[i];
    resumo.lidas++;
    const nome = limparTexto(l[col.nome]).slice(0, 120);
    const cpf = normalizarCpf(l[col.cpf]);
    if (nome.length < 2) { resumo.semNome++; ignorados.push({ linha: i + 1, motivo: 'sem nome' }); continue; }
    if (!cpfValido(cpf)) { resumo.cpfInvalido++; ignorados.push({ linha: i + 1, motivo: 'CPF inválido' }); continue; }
    const id = idLead(produtoId, cpf);
    if (vistos.has(id)) { resumo.duplicadasNoArquivo++; ignorados.push({ linha: i + 1, motivo: 'CPF repetido no arquivo' }); continue; }
    vistos.add(id);
    if (existentes.has(id)) { resumo.jaExistem++; ignorados.push({ linha: i + 1, motivo: 'já existe nesse produto' }); continue; }
    const extras = {};
    for (const idx of extrasUsados) {
      const v = limparTexto(l[idx]).slice(0, 200);
      if (v) extras[limparTexto(cab[idx]).slice(0, 40)] = v;
    }
    leads.push({
      id, nome, cpf,
      telefone: col.tel >= 0 ? normalizarTelefone(l[col.tel]) : '',
      produtoId, loteId, origem, extras,
      ord: leads.length,
    });
    resumo.validas++;
  }
  return { colunas: { nome: cab[col.nome], cpf: cab[col.cpf], tel: col.tel >= 0 ? cab[col.tel] : null, extras: extrasUsados.length }, leads, ignorados, resumo };
}

// ---------- estrutura (planilha de funcionários) ----------
export function lerFuncionarios(linhas) {
  if (!linhas.length) throw new Error('A planilha está vazia.');
  const cab = linhas[0].map((c) => semAcento(limparTexto(c)).toLowerCase());
  const iNome = cab.findIndex((c) => /^nome/.test(c));
  const iLoja = cab.findIndex((c) => /loja|unidade|franquia/.test(c));
  const iCargo = cab.findIndex((c) => /cargo|funcao|perfil/.test(c));
  if (iNome < 0 || iLoja < 0 || iCargo < 0) {
    throw new Error('A planilha precisa ter as colunas Nomes, Loja e Cargo.');
  }
  const pessoas = [];
  const avisos = [];
  const porLoja = new Map();
  for (let i = 1; i < linhas.length; i++) {
    const nome = tituloNome(linhas[i][iNome]);
    const lojaNome = tituloNome(linhas[i][iLoja]);
    const cargo = semAcento(limparTexto(linhas[i][iCargo])).toLowerCase();
    if (!nome && !lojaNome) continue;
    const papel = /supervis/.test(cargo) ? 'supervisor' : /consult/.test(cargo) ? 'consultor' : null;
    if (!nome || !lojaNome || !papel) { avisos.push(`Linha ${i + 1} ignorada (nome, loja ou cargo não reconhecido).`); continue; }
    const lojaId = slug(lojaNome);
    pessoas.push({ nome, lojaNome, lojaId, papel });
    const g = porLoja.get(lojaId) || { nome: lojaNome, supervisores: 0 };
    if (papel === 'supervisor') g.supervisores++;
    porLoja.set(lojaId, g);
  }
  for (const g of porLoja.values()) {
    if (g.supervisores !== 1) avisos.push(`${g.nome}: ${g.supervisores} supervisores (o esperado é 1).`);
  }
  return { pessoas, avisos };
}

export function gerarUsuario(nome, usados = new Set()) {
  const partes = slug(nome).split('-').filter(Boolean);
  const uteis = partes.filter((p) => !PARTICULAS.has(p));
  const primeiro = uteis[0] || partes[0] || 'usuario';
  const ultimo = uteis.length > 1 ? uteis[uteis.length - 1] : '';
  const base = ultimo ? `${primeiro}.${ultimo}` : primeiro;
  let candidato = base;
  let n = 2;
  while (usados.has(candidato)) candidato = `${base}${n++}`;
  return candidato;
}

const ALFABETO_SENHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function gerarSenhaTemporaria(bytesAleatorios, tamanho = 10) {
  const limite = 256 - (256 % ALFABETO_SENHA.length);
  let senha = '';
  while (senha.length < tamanho) {
    for (const b of bytesAleatorios(tamanho * 2)) {
      if (b < limite && senha.length < tamanho) senha += ALFABETO_SENHA[b % ALFABETO_SENHA.length];
    }
  }
  return senha;
}

export function senhaForte(s) {
  return typeof s === 'string' && s.length >= 8 && /[A-Za-z]/.test(s) && /\d/.test(s);
}

// ---------- hierarquia ----------
export function podeGerenciar(ator, alvo) {
  if (!ator || !alvo || ator.ativo === false || ator.id === alvo.id) return false;
  if (ator.role === 'admin') return true;
  if (ator.role === 'diretor') return alvo.role === 'supervisor';
  if (ator.role === 'supervisor') return alvo.role === 'consultor' && !!ator.lojaId && alvo.lojaId === ator.lojaId;
  return false;
}

export function podeEditarLead(ator, lead) {
  if (!ator || ator.ativo === false) return false;
  if (ator.role === 'admin') return true;
  if (ator.role === 'supervisor') return !!ator.lojaId && lead.lojaId === ator.lojaId;
  if (ator.role === 'consultor') return lead.consultorId === ator.id && lead.status !== 'venda';
  return false;
}

// ---------- distribuição ----------
export function dividirIgual(total, partes) {
  if (partes <= 0) return [];
  const base = Math.floor(total / partes);
  const sobra = total % partes;
  return Array.from({ length: partes }, (_, i) => base + (i < sobra ? 1 : 0));
}

export function validarPlano(plano, disponiveis) {
  const soma = {};
  for (const alvo of Object.values(plano)) {
    for (const [prod, q] of Object.entries(alvo)) {
      if (!Number.isInteger(q) || q < 0) return { ok: false, erro: 'Use só números inteiros, sem negativos.' };
      soma[prod] = (soma[prod] || 0) + q;
    }
  }
  for (const [prod, q] of Object.entries(soma)) {
    if (q > (disponiveis[prod] || 0)) return { ok: false, erro: 'Tem produto com mais leads do que o disponível.', produto: prod };
  }
  const total = Object.values(soma).reduce((a, b) => a + b, 0);
  return { ok: total > 0, erro: total > 0 ? null : 'Informe pelo menos 1 lead.', total, soma };
}

export function fatiarDistribuicao(leadsPorProduto, plano, ordemAlvos) {
  const saida = [];
  for (const [prod, lista] of Object.entries(leadsPorProduto)) {
    let pos = 0;
    for (const alvo of ordemAlvos) {
      const q = plano[alvo]?.[prod] || 0;
      for (let i = 0; i < q && pos < lista.length; i++) saida.push({ leadId: lista[pos++].id, alvoId: alvo });
    }
  }
  return saida;
}

// ---------- indicações ----------
export function validarIndicacoes(lista, cpfCliente) {
  const erros = [];
  const itens = [];
  const cpfs = new Set([cpfCliente]);
  for (let i = 0; i < TOTAL_INDICACOES; i++) {
    const it = lista[i] || {};
    const nome = limparTexto(it.nome).slice(0, 120);
    const cpf = normalizarCpf(it.cpf);
    const telBruto = soDigitos(it.telefone);
    const telefone = normalizarTelefone(it.telefone);
    let erro = null;
    if (nome.length < 2) erro = 'Informe o nome.';
    else if (!cpfValido(cpf)) erro = 'CPF inválido.';
    else if (cpfs.has(cpf)) erro = cpf === cpfCliente ? 'É o CPF do próprio cliente.' : 'CPF repetido nas indicações.';
    else if (telBruto && !telefone) erro = 'Telefone inválido (use DDD + número).';
    erros.push(erro);
    if (!erro) cpfs.add(cpf);
    itens.push({ nome, cpf, telefone });
  }
  return { ok: erros.every((e) => !e), erros, itens };
}

export function idIndicacao(leadId, n) {
  return `ind_${leadId}_${n}`;
}

// ---------- relatório ----------
export function conversao(vendas, leads) {
  return leads > 0 ? vendas / leads : null;
}
export function formatarPct(v) {
  if (v === null || v === undefined) return '–';
  return `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

const novoTotal = () => ({ leads: 0, vendas: 0 });
function somar(t, lead) {
  t.leads++;
  if (lead.status === 'venda') t.vendas++;
}
const comConv = (t) => ({ ...t, conv: conversao(t.vendas, t.leads) });
const porConv = (a, b) => (b.conv ?? -1) - (a.conv ?? -1) || b.leads - a.leads;

// Base do relatório = leads que a diretoria distribuiu (indicações ficam de fora
// da conversão para não inflar o resultado; aparecem numa coluna à parte).
export function montarRelatorio(leads, { produtoId = '', loteId = '' } = {}) {
  const passa = (l) => (!produtoId || l.produtoId === produtoId) && (!loteId || l.loteId === loteId);
  const base = leads.filter((l) => !l.indicacao && l.lojaId && passa(l));
  const indic = leads.filter((l) => l.indicacao && l.lojaId && passa(l));

  const geral = novoTotal();
  const produtos = {};
  const lojas = {};
  const consultores = {};
  for (const l of base) {
    somar(geral, l);
    somar((produtos[l.produtoId] ??= novoTotal()), l);
    const lj = (lojas[l.lojaId] ??= { total: novoTotal(), porProduto: {}, indic: novoTotal() });
    somar(lj.total, l);
    somar((lj.porProduto[l.produtoId] ??= novoTotal()), l);
    if (l.consultorId) {
      const c = (consultores[l.consultorId] ??= { lojaId: l.lojaId, total: novoTotal(), indic: novoTotal() });
      somar(c.total, l);
    }
  }
  for (const l of indic) {
    const lj = (lojas[l.lojaId] ??= { total: novoTotal(), porProduto: {}, indic: novoTotal() });
    somar(lj.indic, l);
    if (l.consultorId) {
      const c = (consultores[l.consultorId] ??= { lojaId: l.lojaId, total: novoTotal(), indic: novoTotal() });
      somar(c.indic, l);
    }
  }

  return {
    geral: comConv(geral),
    produtos: Object.entries(produtos).map(([id, t]) => ({ id, ...comConv(t) })).sort(porConv),
    lojas: Object.entries(lojas)
      .map(([id, l]) => ({
        id,
        ...comConv(l.total),
        indic: l.indic,
        porProduto: Object.fromEntries(Object.entries(l.porProduto).map(([p, t]) => [p, comConv(t)])),
      }))
      .sort(porConv),
    consultores: Object.entries(consultores)
      .map(([id, c]) => ({ id, lojaId: c.lojaId, ...comConv(c.total), indic: c.indic }))
      .sort(porConv),
  };
}

export function contarStatus(leads) {
  const r = Object.fromEntries(STATUS.map((s) => [s.id, 0]));
  for (const l of leads) if (l.status in r) r[l.status]++;
  return r;
}
