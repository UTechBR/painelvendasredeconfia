// app.js — Painel de Leads da Rede Confia (lojas Help).
// Tela + conversa com o Firebase. As regras de negócio ficam em logic.js.
// IMPORTANTE: quem protege os dados é o arquivo firestore.rules; esta tela só esconde o que a pessoa não pode usar.

import { firebaseConfig } from './firebase-config.js';
import * as L from './logic.js';
import { lerXlsx } from './xlsx.js';
import { iniciarRede } from './fundo.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeAuth, browserSessionPersistence, inMemoryPersistence, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, onAuthStateChanged, updatePassword,
  reauthenticateWithCredential, EmailAuthProvider,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, onSnapshot, query, where, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const raiz = document.getElementById('app');
const DOMINIO_INTERNO = 'painel-help.invalid'; // e-mail fictício: ninguém recebe nada nele
const INATIVIDADE_MS = 30 * 60 * 1000;
const LINHAS_POR_PAGINA = 100;
const TAMANHO_LOTE_ESCRITA = 400;

const estado = {
  me: null, bootstrap: false,
  produtos: [], lojas: [], usuarios: [], lotes: [],
  leadsMap: new Map(), leadsCache: null, leadsPronto: false,
  aba: 'leads',
  f: { status: '', produto: '', consultor: '', loja: '', busca: '', limite: LINHAS_POR_PAGINA },
  dist: { modo: 'lojas', loja: '', lote: '', plano: {} },
  rel: { produto: '', lote: '' },
  rank: { produto: '', periodo: 'mes', modo: 'lojas' },
  cobranca: null, cobrancas: new Map(),
  roteiros: [], rot: { id: null, pagina: 1, busca: '', paginas: null, chave: '', carregando: false, erro: false },
  desinscrever: [], modais: 0, renderPendente: false, timerInatividade: null,
};

let app; let auth; let db; let appSec; let authSec;

// ---------- utilidades de tela ----------
function h(tag, props = {}, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const f of filhos.flat(Infinity)) {
    if (f === null || f === undefined || f === false) continue;
    el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return el;
}
function limpar(n) { while (n.firstChild) n.removeChild(n.firstChild); }
function carregandoLogo(texto = 'Carregando…') {
  return h('div', { class: 'carregando', role: 'status' },
    h('div', { class: 'carregando-logo' }, h('img', { src: 'img/logo-rc.png', alt: 'Rede Confia' })),
    h('span', { text: texto }));
}
function hoje() { return new Date().toLocaleDateString('sv-SE'); }
function agoraBr() { return new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }
function hex(n) { return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join(''); }
function bytesAleatorios(n) { return crypto.getRandomValues(new Uint8Array(n)); }

function aviso(msg, tipo = '') {
  const t = h('div', { class: `toast ${tipo}`, role: 'status', text: msg });
  document.getElementById('avisos').append(t);
  setTimeout(() => t.remove(), tipo === 'erro' ? 6000 : 3500);
}

function campo(rotulo, input, dica) {
  const id = `c${hex(4)}`;
  input.id = id;
  return h('div', {}, h('label', { for: id, text: rotulo }), input, dica ? h('p', { class: 'dica', text: dica }) : null);
}

function abrirModal(titulo, conteudo, { largo = false, fechavel = true } = {}) {
  estado.modais++;
  const fundo = h('div', { class: 'fundo-modal' });
  const caixa = h('div', { class: `modal${largo ? ' largo' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': titulo });
  const fechar = () => {
    if (!fundo.isConnected) return;
    fundo.remove();
    document.removeEventListener('keydown', teclas);
    estado.modais--;
    if (estado.renderPendente) agendarRender();
  };
  const teclas = (e) => { if (e.key === 'Escape' && fechavel) fechar(); };
  document.addEventListener('keydown', teclas);
  caixa.append(h('header', {}, h('h2', { text: titulo }), fechavel ? h('button', { class: 'btn sec peq', 'aria-label': 'Fechar', onclick: fechar, text: 'Fechar' }) : null), conteudo);
  fundo.append(caixa);
  document.body.append(fundo);
  caixa.querySelector('input,select,textarea,button.btn')?.focus();
  return { fechar, caixa };
}

function confirmar(titulo, texto, rotulo = 'Confirmar', perigo = false) {
  return new Promise((resolve) => {
    let m;
    const fim = (v) => { m.fechar(); resolve(v); };
    m = abrirModal(titulo, h('div', {},
      h('p', { text: texto }),
      h('div', { class: 'acoes' },
        h('button', { class: 'btn sec', onclick: () => fim(false), text: 'Cancelar' }),
        h('button', { class: `btn${perigo ? ' perigo' : ''}`, onclick: () => fim(true), text: rotulo }))));
  });
}

function confirmarDigitando(titulo, texto, palavra) {
  return new Promise((resolve) => {
    let m;
    const fim = (v) => { m.fechar(); resolve(v); };
    const entrada = h('input', { type: 'text', autocomplete: 'off', 'aria-label': `Digite ${palavra} para confirmar` });
    const ok = h('button', { class: 'btn perigo', disabled: true, onclick: () => fim(true), text: 'Excluir' });
    entrada.addEventListener('input', () => { ok.disabled = entrada.value.trim() !== palavra; });
    m = abrirModal(titulo, h('div', {},
      h('p', { text: texto }),
      campo(`Digite ${palavra} para confirmar`, entrada),
      h('div', { class: 'acoes' }, h('button', { class: 'btn sec', onclick: () => fim(false), text: 'Cancelar' }), ok)));
  });
}

function mostrarSenha(titulo, itens) {
  const linhas = itens.map((i) => `${i.nome};${i.usuario};${i.senha}`);
  const corpo = h('div', {},
    h('p', { text: 'Entregue cada senha provisória pessoalmente. Ela aparece só agora e precisa ser trocada no primeiro acesso.' }),
    h('div', { class: 'tabela-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'Nome' }), h('th', { text: 'Usuário' }), h('th', { text: 'Senha provisória' }))),
      h('tbody', {}, itens.map((i) => h('tr', {}, h('td', { text: i.nome }), h('td', { text: i.usuario }), h('td', {}, h('span', { class: 'senha', text: i.senha }))))))),
    h('div', { class: 'acoes' },
      h('button', {
        class: 'btn sec',
        onclick: () => baixarCsv('acessos.csv', ['Nome;Usuário;Senha provisória', ...linhas.map((l) => L.linhaCsv(l.split(';')))]),
        text: 'Baixar lista (CSV)',
      }),
      h('button', {
        class: 'btn', text: 'Copiar',
        onclick: async () => { try { await navigator.clipboard.writeText(['Nome\tUsuário\tSenha provisória', ...itens.map((i) => `${i.nome}\t${i.usuario}\t${i.senha}`)].join('\n')); aviso('Copiado.'); } catch { aviso('Não consegui copiar. Selecione e copie à mão.', 'erro'); } },
      })));
  abrirModal(titulo, corpo, { largo: itens.length > 1 });
}

function baixarCsv(nome, linhas) {
  const blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: nome });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function lerArquivoTabela(arquivo) {
  if (!arquivo) throw new Error('Escolha um arquivo.');
  if (arquivo.size > 25 * 1024 * 1024) throw new Error('Arquivo grande demais (máximo 25 MB).');
  const nome = arquivo.name.toLowerCase();
  if (nome.endsWith('.xlsx')) return lerXlsx(await arquivo.arrayBuffer());
  if (nome.endsWith('.csv') || nome.endsWith('.txt')) {
    const buf = await arquivo.arrayBuffer();
    let texto = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (texto.includes('�')) texto = new TextDecoder('windows-1252').decode(buf);
    return L.parseCsv(texto);
  }
  throw new Error('Use um arquivo .xlsx ou .csv (se for .xls, abra no Excel e salve como .xlsx).');
}

// ---------- dados derivados ----------
const leadsLista = () => (estado.leadsCache ??= [...estado.leadsMap.values()]);
const nomeProduto = (id) => estado.produtos.find((p) => p.id === id)?.nome || id;
const nomeLoja = (id) => estado.lojas.find((l) => l.id === id)?.nome || (id ? id : '—');
const usuarioPorId = (id) => estado.usuarios.find((u) => u.id === id);
const nomeUsuario = (id) => usuarioPorId(id)?.nome || (id ? id : '—');
const supervisorDaLoja = (lojaId) => estado.usuarios.find((u) => u.role === 'supervisor' && u.lojaId === lojaId && u.ativo);
const produtosAtivos = () => estado.produtos.filter((p) => p.ativo !== false);
const lojasAtivas = () => estado.lojas.filter((l) => l.ativo !== false);
const consultoresDaLoja = (lojaId) => estado.usuarios.filter((u) => u.role === 'consultor' && u.lojaId === lojaId && u.ativo);
const ehAdmin = () => estado.me?.role === 'admin';
const ehDiretor = () => estado.me?.role === 'diretor';
const ehSupervisor = () => estado.me?.role === 'supervisor';
const ehConsultor = () => estado.me?.role === 'consultor';
const verTudo = () => ehAdmin() || ehDiretor();
const rotuloStatus = (id) => L.STATUS.find((s) => s.id === id)?.nome || id;
const descStatus = (id) => L.STATUS.find((s) => s.id === id)?.desc || '';
const dataBr = (iso) => (iso || '').split('-').reverse().join('/');
// Retorno agendado: data e hora combinadas com o cliente
const retornoMs = (l) => (l.status === 'retornar' && l.retornarEm ? new Date(`${l.retornarEm}T${l.retornarHora || '00:00'}:00`).getTime() : null);
function rotuloLead(l) {
  const t = retornoMs(l);
  if (t === null) return rotuloStatus(l.status);
  const agora = Date.now();
  const aviso = t <= agora ? ' · atrasado' : l.retornarEm === hoje() ? ' · hoje' : '';
  return `Retorno agendado · ${dataBr(l.retornarEm)}${l.retornarHora ? ` ${l.retornarHora}` : ''}${aviso}`;
}

// ---------- inicialização ----------
function configurado() {
  return Boolean(firebaseConfig?.apiKey) && !String(firebaseConfig.apiKey).startsWith('COLE');
}

function telaSemConfig() {
  limpar(raiz);
  raiz.append(h('div', { class: 'centro' }, h('div', { class: 'cartao' },
    h('h2', { text: 'Falta ligar o painel ao Firebase' }),
    h('p', { text: 'Abra o arquivo firebase-config.js, cole os dados do seu projeto Firebase e publique de novo. O passo a passo está no LEIA-ME.' }))));
}

async function iniciar() {
  if (!configurado()) { telaSemConfig(); return; }
  app = initializeApp(firebaseConfig);
  auth = initializeAuth(app, { persistence: browserSessionPersistence });
  db = getFirestore(app);
  appSec = initializeApp(firebaseConfig, 'secundario');
  authSec = initializeAuth(appSec, { persistence: inMemoryPersistence });

  onAuthStateChanged(auth, async (user) => {
    if (estado.bootstrap) return;
    if (!user) { encerrarDados(); await telaEntrada(); return; }
    await iniciarSessao(user);
  });
}

async function telaEntrada(mensagem = '') {
  let setupFeito = true;
  try {
    setupFeito = (await getDoc(doc(db, 'config', 'setup'))).exists();
  } catch {
    mensagem = mensagem || 'Não consegui falar com o Firebase. Confira a configuração e se as regras foram publicadas.';
  }
  if (!setupFeito) telaPrimeiroAcesso(); else telaLogin(mensagem);
}

function telaLogin(mensagem = '') {
  limpar(raiz);
  const erro = h('div', { class: 'erro', role: 'alert', hidden: !mensagem, text: mensagem });
  const usuario = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const senha = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const botao = h('button', { class: 'btn', type: 'submit', text: 'Entrar' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      botao.disabled = true;
      erro.hidden = true;
      try {
        await entrar(usuario.value, senha.value);
      } catch (err) {
        erro.textContent = err.mensagem || 'Usuário ou senha incorretos.';
        erro.hidden = false;
        botao.disabled = false;
      }
    },
  },
  campo('Usuário', usuario), campo('Senha', senha), erro, h('div', { style: 'margin-top:16px' }, botao),
  h('p', { class: 'dica', text: 'Esqueceu a senha? Peça para o seu supervisor redefinir.' }));
  montarEntrada(h('div', { class: 'cartao' }, form));
  usuario.focus();
}

// Tela de entrada: à esquerda a rede animada da Rede Confia; à direita o cartão (login ou primeiro acesso).
function montarEntrada(cartao) {
  const canvas = h('canvas', { 'aria-hidden': 'true' });
  const hero = h('section', { class: 'hero', 'aria-label': 'Rede Confia' },
    canvas,
    h('img', { class: 'hero-logo', src: 'img/logo-rc.png', alt: 'Rede Confia' }),
    h('p', { class: 'hero-dica', text: 'Toque na tela e envie leads para as lojas' }));
  raiz.append(h('div', { class: 'entrada' }, hero,
    h('div', { class: 'entrada-form' }, h('div', { class: 'centro' },
      h('div', { class: 'logo' }, h('img', { src: 'logo.png', alt: 'Help – Loja de Crédito' })), cartao))));
  iniciarRede(canvas, { marca: 'img/marca-rc.png?v=2' });
}

async function entrar(usuarioBruto, senha) {
  const usuario = String(usuarioBruto).trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,40}$/.test(usuario) || !senha) throw new Error('invalido');
  const login = await getDoc(doc(db, 'logins', usuario));
  if (!login.exists()) throw new Error('invalido');
  try {
    await signInWithEmailAndPassword(auth, login.data().email, senha);
  } catch (e) {
    if (String(e.code).includes('too-many-requests')) throw Object.assign(new Error('x'), { mensagem: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
    if (String(e.code).includes('network')) throw Object.assign(new Error('x'), { mensagem: 'Sem conexão. Tente de novo.' });
    throw new Error('invalido');
  }
}

function telaPrimeiroAcesso() {
  limpar(raiz);
  const erro = h('div', { class: 'erro', role: 'alert', hidden: true });
  const nome = h('input', { type: 'text', required: true, autocomplete: 'name' });
  const usuario = h('input', { type: 'text', required: true, autocapitalize: 'none', value: 'admin' });
  const senha = h('input', { type: 'password', required: true, autocomplete: 'new-password' });
  const senha2 = h('input', { type: 'password', required: true, autocomplete: 'new-password' });
  const botao = h('button', { class: 'btn', type: 'submit', text: 'Criar administrador' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      erro.hidden = true;
      const u = usuario.value.trim().toLowerCase();
      if (L.limparTexto(nome.value).length < 2) return falha('Informe o seu nome.');
      if (!/^[a-z0-9._-]{2,40}$/.test(u)) return falha('Usuário: use só letras minúsculas, números, ponto ou traço.');
      if (!L.senhaForte(senha.value)) return falha('A senha precisa ter 8 ou mais caracteres, com letras e números.');
      if (senha.value !== senha2.value) return falha('As senhas não conferem.');
      botao.disabled = true;
      estado.bootstrap = true;
      try {
        const email = `${u}.${hex(4)}@${DOMINIO_INTERNO}`;
        const cred = await createUserWithEmailAndPassword(auth, email, senha.value);
        const uid = cred.user.uid;
        const b = writeBatch(db);
        b.set(doc(db, 'usuarios', uid), { id: u, nome: L.limparTexto(nome.value), usuario: u, role: 'admin', lojaId: null, ativo: true, mustChange: false, criadoEm: serverTimestamp() });
        b.set(doc(db, 'config', 'setup'), { feito: true, em: serverTimestamp() });
        b.set(doc(db, 'logins', u), { email, uid });
        await b.commit();
        estado.bootstrap = false;
        await iniciarSessao(cred.user);
      } catch (err) {
        console.error('primeiro acesso', err?.code || err);
        estado.bootstrap = false;
        try { await signOut(auth); } catch { /* sem sessão para encerrar */ }
        falha('Não consegui criar. Confira se as regras do Firestore foram publicadas e tente de novo.');
        botao.disabled = false;
      }
      return undefined;
    },
  },
  campo('Seu nome', nome), campo('Usuário', usuario), campo('Senha', senha, 'Mínimo de 8 caracteres, com letras e números.'), campo('Repita a senha', senha2), erro,
  h('div', { style: 'margin-top:16px' }, botao));
  function falha(msg) { erro.textContent = msg; erro.hidden = false; }
  montarEntrada(h('div', { class: 'cartao' }, h('h2', { text: 'Primeiro acesso' }), h('p', { class: 'dica', text: 'Crie agora o administrador do painel. Esta tela só aparece uma vez.' }), form));
}

async function iniciarSessao(user) {
  try {
    const snap = await getDoc(doc(db, 'usuarios', user.uid));
    if (!snap.exists() || snap.data().ativo !== true) {
      await signOut(auth);
      telaLogin('Seu acesso não está liberado. Fale com o seu supervisor.');
      return;
    }
    estado.me = { ...snap.data(), uid: user.uid };
    if (estado.me.mustChange) await trocarSenhaObrigatoria();
    estado.aba = abasDoPerfil()[0];
    iniciarDados();
    telaApp();
    reiniciarInatividade();
  } catch (e) {
    console.error('sessão', e?.code || e);
    try { await signOut(auth); } catch { /* ignora */ }
    telaLogin('Não consegui abrir o seu acesso. Tente de novo.');
  }
}

function reiniciarInatividade() {
  clearTimeout(estado.timerInatividade);
  if (!estado.me) return;
  estado.timerInatividade = setTimeout(() => sair('Sessão encerrada por inatividade.'), INATIVIDADE_MS);
}
['click', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (estado.me) reiniciarInatividade(); }, { passive: true }));

async function sair(msg = '') {
  clearTimeout(estado.timerInatividade);
  encerrarDados();
  estado.me = null;
  try { await signOut(auth); } catch { /* ignora */ }
  if (msg) telaLogin(msg);
}

function encerrarDados() {
  clearInterval(estado.timerLembretes); estado.timerLembretes = null;
  document.querySelectorAll('#avisos .lembrete, #avisos .toast').forEach((e) => e.remove());
  estado.cobranca = null; estado.cobrancas = new Map();
  estado.desinscrever.forEach((f) => f());
  estado.desinscrever = [];
  estado.leadsMap = new Map();
  estado.leadsCache = null;
  estado.leadsPronto = false;
  estado.produtos = []; estado.lojas = []; estado.usuarios = []; estado.lotes = []; estado.roteiros = [];
  estado.rot = { id: null, pagina: 1, busca: '', paginas: null, chave: '', carregando: false, erro: false };
}

// ---------- troca de senha ----------
function trocarSenhaObrigatoria() {
  return new Promise((resolve) => {
    const erro = h('div', { class: 'erro', hidden: true, role: 'alert' });
    const nova = h('input', { type: 'password', autocomplete: 'new-password', required: true });
    const rep = h('input', { type: 'password', autocomplete: 'new-password', required: true });
    const botao = h('button', { class: 'btn', type: 'submit', text: 'Salvar nova senha' });
    let m;
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        erro.hidden = true;
        if (!L.senhaForte(nova.value)) { erro.textContent = 'A senha precisa ter 8 ou mais caracteres, com letras e números.'; erro.hidden = false; return; }
        if (nova.value !== rep.value) { erro.textContent = 'As senhas não conferem.'; erro.hidden = false; return; }
        botao.disabled = true;
        try {
          await updatePassword(auth.currentUser, nova.value);
          await updateDoc(doc(db, 'usuarios', estado.me.uid), { mustChange: false });
          estado.me.mustChange = false;
          m.fechar();
          resolve();
        } catch (err) {
          console.error('troca de senha', err?.code || err);
          erro.textContent = 'Não consegui trocar a senha. Saia e entre de novo.';
          erro.hidden = false;
          botao.disabled = false;
        }
      },
    }, h('p', { text: `Olá, ${estado.me.nome}. Antes de continuar, crie a sua senha pessoal.` }),
    campo('Nova senha', nova, 'Mínimo de 8 caracteres, com letras e números.'), campo('Repita a nova senha', rep), erro, h('div', { class: 'acoes' }, botao));
    m = abrirModal('Crie a sua senha', form, { fechavel: false });
  });
}

function abrirAlterarSenha() {
  const erro = h('div', { class: 'erro', hidden: true, role: 'alert' });
  const atual = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const nova = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const rep = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const botao = h('button', { class: 'btn', type: 'submit', text: 'Salvar' });
  let m;
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      erro.hidden = true;
      if (!L.senhaForte(nova.value)) { erro.textContent = 'A nova senha precisa ter 8 ou mais caracteres, com letras e números.'; erro.hidden = false; return; }
      if (nova.value !== rep.value) { erro.textContent = 'As senhas não conferem.'; erro.hidden = false; return; }
      botao.disabled = true;
      try {
        await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, atual.value));
        await updatePassword(auth.currentUser, nova.value);
        m.fechar();
        aviso('Senha alterada.');
      } catch (err) {
        erro.textContent = String(err.code).includes('wrong-password') || String(err.code).includes('invalid-credential') ? 'A senha atual está incorreta.' : 'Não consegui trocar a senha. Tente de novo.';
        erro.hidden = false;
        botao.disabled = false;
      }
    },
  }, campo('Senha atual', atual), campo('Nova senha', nova), campo('Repita a nova senha', rep), erro, h('div', { class: 'acoes' }, botao));
  m = abrirModal('Alterar minha senha', form);
}

// ---------- dados em tempo real ----------
function ouvir(consulta, aoReceber, silencioso = false) {
  const cancelar = onSnapshot(consulta, aoReceber, (err) => {
    console.error('leitura', err?.code || err);
    if (!silencioso) aviso('Sem permissão ou sem conexão para carregar alguns dados.', 'erro');
  });
  estado.desinscrever.push(cancelar);
}
const docsComId = (snap) => snap.docs.map((d) => ({ _uid: d.id, id: d.id, ...d.data() }));

function iniciarDados() {
  const me = estado.me;
  ouvir(collection(db, 'produtos'), (s) => {
    estado.produtos = docsComId(s).sort((a, b) => (a.ordem ?? 99) - (b.ordem ?? 99));
    if (ehAdmin() && s.empty) semearProdutos();
    agendarRender();
  });
  ouvir(collection(db, 'lojas'), (s) => { estado.lojas = docsComId(s).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')); agendarRender(); });
  const usuariosConsulta = verTudo() ? collection(db, 'usuarios') : ehSupervisor() ? query(collection(db, 'usuarios'), where('lojaId', '==', me.lojaId)) : null;
  if (usuariosConsulta) {
    ouvir(usuariosConsulta, (s) => {
      // em usuários, "id" é o nome de usuário (estável); o id do documento fica em _uid
      estado.usuarios = s.docs.map((d) => ({ ...d.data(), _uid: d.id })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      agendarRender();
    });
  }
  ouvir(collection(db, 'roteiros'), (s) => { estado.roteiros = docsComId(s).sort((x, y) => x.titulo.localeCompare(y.titulo, 'pt-BR')); agendarRender(); });
  // cobranças de distribuição (silencioso: se as regras ainda não foram publicadas, o painel segue normal)
  if (verTudo()) {
    ouvir(collection(db, 'cobrancas'), (s) => { estado.cobrancas = new Map(docsComId(s).map((c) => [c.lojaId, c])); agendarRender(); }, true);
  } else if (ehSupervisor() && me.lojaId) {
    ouvir(query(collection(db, 'cobrancas'), where('lojaId', '==', me.lojaId)), (s) => { estado.cobranca = docsComId(s)[0] || null; atualizarCobranca(); }, true);
  }
  if (verTudo()) ouvir(collection(db, 'lotes'), (s) => { estado.lotes = docsComId(s).sort((a, b) => (a.id < b.id ? 1 : -1)); agendarRender(); });
  const leadsConsulta = verTudo() ? collection(db, 'leads')
    : ehSupervisor() ? query(collection(db, 'leads'), where('lojaId', '==', me.lojaId))
      : query(collection(db, 'leads'), where('consultorId', '==', me.id));
  ouvir(leadsConsulta, (s) => {
    for (const ch of s.docChanges()) {
      if (ch.type === 'removed') estado.leadsMap.delete(ch.doc.id);
      else estado.leadsMap.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
    }
    estado.leadsCache = null;
    estado.leadsPronto = true;
    iniciarLembretes();
    agendarRender();
  });
}

// ---------- lembretes de "Retorno agendado" ----------
function pedirPermissaoAvisos() {
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* sem suporte */ }
}
const chaveAviso = (l) => `${l.id}|${l.retornarEm}|${l.retornarHora || ''}`;
function jaAvisado(l) { try { return (JSON.parse(localStorage.getItem('avisadosRetorno') || '[]')).includes(chaveAviso(l)); } catch { return false; } }
function marcarAvisado(l) {
  try { const v = JSON.parse(localStorage.getItem('avisadosRetorno') || '[]'); v.push(chaveAviso(l)); localStorage.setItem('avisadosRetorno', JSON.stringify(v.slice(-300))); } catch { /* sem armazenamento: avisa de novo no próximo ciclo */ }
}
function apito() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    const o = c.createOscillator(); const g = c.createGain();
    o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); setTimeout(() => { o.stop(); c.close(); }, 350);
  } catch { /* o navegador pode bloquear som sem clique prévio */ }
}
function meuRetorno(l) {
  const me = estado.me;
  if (!me || l.status !== 'retornar') return false;
  if (me.role === 'consultor') return l.consultorId === me.id;
  if (me.role === 'supervisor') return l.lojaId === me.lojaId && (!l.consultorId || l.consultorId === me.id);
  return false;
}
function verificarRetornos() {
  if (!estado.me || !estado.leadsPronto) return;
  const vencidos = leadsLista().filter((l) => meuRetorno(l) && retornoMs(l) !== null && retornoMs(l) <= Date.now() && !jaAvisado(l))
    .sort((x, y) => retornoMs(x) - retornoMs(y));
  vencidos.slice(0, 5).forEach((l) => {
    marcarAvisado(l);
    const titulo = 'Hora do retorno';
    const texto = `${l.nome}${l.telefone ? ` · ${L.formatarTelefone(l.telefone)}` : ''} (marcado para ${dataBr(l.retornarEm)} ${l.retornarHora || ''})`.trim();
    const cartao = h('div', { class: 'lembrete', role: 'alert' },
      h('strong', { text: titulo }), h('span', { text: texto }),
      h('div', { class: 'acoes' },
        h('button', { class: 'btn peq', text: 'Abrir ficha', onclick: () => { cartao.remove(); abrirFicha(l.id); } }),
        h('button', { class: 'btn sec peq', text: 'Dispensar', onclick: () => cartao.remove() })));
    document.getElementById('avisos').append(cartao);
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification(titulo, { body: texto, tag: chaveAviso(l) }); } catch { /* sem suporte */ }
  });
  if (vencidos.length > 5) aviso(`Mais ${vencidos.length - 5} retornos esperando. Veja em Leads ("Retorno agendado").`);
  if (vencidos.length) apito();
}
function tiquePainel() { verificarRetornos(); atualizarFaixa(); atualizarCobranca(); }
function iniciarLembretes() {
  if (estado.timerLembretes) { tiquePainel(); return; }
  estado.timerLembretes = setInterval(tiquePainel, 20000);
  tiquePainel();
}

// ---------- distribuição pendente: faixa do supervisor, aviso de cobrança e quadro do gerente ----------
function minhaPendencia() {
  if (!ehSupervisor() || !estado.leadsPronto || !estado.me.lojaId) return null;
  return L.pendenciasDistribuicao(leadsLista()).find((p) => p.lojaId === estado.me.lojaId) || null;
}

// Faixa fixa no topo (supervisor): fica até os leads da loja terem consultor.
function atualizarFaixa() {
  const el = document.getElementById('faixa-pend');
  if (!el) return;
  const p = estado.aba === 'distribuir' ? null : minhaPendencia();
  if (!p) { el.className = ''; el.hidden = true; limpar(el); return; }
  const chave = `${p.qtd}|${p.dias}`;
  if (el.dataset.chave === chave && !el.hidden) return;
  el.dataset.chave = chave;
  el.hidden = false;
  el.className = `faixa-pend ${p.nivel}`;
  limpar(el);
  el.append(h('span', { text: `Você tem ${L.textoPendencia(p.qtd, p.dias)}.` }),
    h('button', { class: 'btn peq', text: 'Distribuir agora', onclick: () => { estado.aba = 'distribuir'; telaApp(); } }));
}

// Aviso de cobrança (supervisor): fica na tela, com som, até ele confirmar que viu.
function atualizarCobranca() {
  const cont = document.getElementById('avisos');
  if (!cont) return;
  const velho = document.getElementById('aviso-cobranca');
  const c = estado.cobranca;
  const p = minhaPendencia();
  if (!(c && p && c.ultima > (c.visto || 0))) { velho?.remove(); return; }
  const texto = `${c.porNome} pediu que você distribua os leads da sua loja (${L.textoPendencia(p.qtd, p.dias)}).`;
  if (velho && velho.dataset.ultima === String(c.ultima)) { velho.querySelector('span').textContent = texto; return; }
  velho?.remove();
  const cartao = h('div', { class: 'lembrete cobranca', id: 'aviso-cobranca', role: 'alert', 'data-ultima': String(c.ultima) },
    h('strong', { text: 'Cobrança de distribuição' }), h('span', { text: texto }),
    h('div', { class: 'acoes' },
      h('button', { class: 'btn peq', text: 'Vou distribuir agora', onclick: async () => {
        cartao.remove();
        try { await updateDoc(doc(db, 'cobrancas', c.lojaId), { visto: c.ultima }); } catch (e) { console.error('cobranca ciente', e?.code || e); }
        estado.aba = 'distribuir'; telaApp();
      } })));
  cont.append(cartao);
  apito(); setTimeout(apito, 450);
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification('Cobrança de distribuição', { body: texto, tag: 'cobranca' }); } catch { /* sem suporte */ }
}

async function cobrarLoja(p, supervisor) {
  const ant = estado.cobrancas.get(p.lojaId);
  try {
    await setDoc(doc(db, 'cobrancas', p.lojaId), {
      lojaId: p.lojaId, vezes: (ant?.vezes || 0) + 1, ultima: Math.max(Date.now(), (ant?.ultima || 0) + 1),
      porNome: estado.me.nome, visto: ant?.visto || 0,
    });
    aviso(`Cobrança enviada para ${supervisor.nome}.`);
  } catch (e) {
    console.error('cobrar', e?.code || e);
    aviso('Não consegui enviar a cobrança. Tente de novo.', 'erro');
  }
}

// Quadro do Gerente Geral / Admin: lojas com leads parados, as mais atrasadas primeiro.
function quadroPendencias() {
  if (!estado.leadsPronto) return null;
  const lista = L.pendenciasDistribuicao(leadsLista());
  const quando = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const titulo = h('h2', { text: 'Distribuição pendente nas lojas' });
  if (!lista.length) return h('div', { class: 'cartao' }, titulo, h('p', { class: 'ok-pend', text: 'Tudo distribuído ✓' }));
  return h('div', { class: 'cartao' }, titulo, h('div', { class: 'tabela-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', { text: 'Loja' }), h('th', { class: 'num', text: 'Sem consultor' }), h('th', { text: 'Parados há' }), h('th', { text: 'Cobranças' }), h('th'))),
    h('tbody', {}, lista.map((p) => {
      const sup = supervisorDaLoja(p.lojaId);
      const c = estado.cobrancas.get(p.lojaId);
      const situacao = !c ? '—' : `${c.vezes}× · ${quando(c.ultima)} · ${c.ultima > (c.visto || 0) ? 'ainda não visto' : 'visto'}`;
      return h('tr', {},
        h('td', {}, nomeLoja(p.lojaId), h('div', { class: 'dica', text: sup ? `Supervisor: ${sup.nome}` : 'sem supervisor' })),
        h('td', { class: 'num', text: String(p.qtd) }),
        h('td', {}, h('span', { class: `atraso ${p.nivel}`, text: p.dias === 0 ? 'hoje' : L.plural(p.dias, 'dia', 'dias') })),
        h('td', { text: situacao }),
        h('td', {}, h('button', { class: 'btn peq', text: 'Cobrar', disabled: !sup, title: sup ? '' : 'A loja não tem supervisor cadastrado', 'aria-label': `Cobrar ${nomeLoja(p.lojaId)}`, onclick: (e) => { e.target.disabled = true; cobrarLoja(p, sup).then(() => { e.target.disabled = !sup; }); } })));
    })))));
}

async function semearProdutos() {
  if (estado.semeando) return;
  estado.semeando = true;
  try {
    const b = writeBatch(db);
    [['saque-complementar', 'Saque complementar'], ['cnc', 'CNC'], ['clt', 'CLT']].forEach(([id, nome], i) => {
      b.set(doc(db, 'produtos', id), { nome, ativo: true, ordem: i });
    });
    await b.commit();
  } catch (e) { console.error('produtos iniciais', e?.code || e); } finally { estado.semeando = false; }
}

function agendarRender() {
  if (!estado.me || !document.getElementById('conteudo')) return;
  const foco = document.activeElement;
  const digitando = foco && /^(INPUT|TEXTAREA|SELECT)$/.test(foco.tagName) && document.getElementById('conteudo')?.contains(foco);
  // a tela de importação guarda o arquivo e a prévia em memória: nunca é refeita enquanto estiver em uso
  if (estado.aba === 'importar' && estado.importarEmUso) return;
  if (estado.modais > 0 || digitando) { estado.renderPendente = true; return; }
  estado.renderPendente = false;
  if (!estado.renderAgendado) {
    estado.renderAgendado = true;
    requestAnimationFrame(() => { estado.renderAgendado = false; renderConteudo(); });
  }
}
document.addEventListener('focusout', () => { if (estado.renderPendente) setTimeout(agendarRender, 150); });

// ---------- esqueleto da tela ----------
const ABAS = {
  leads: 'Leads', distribuir: 'Distribuir', relatorio: 'Relatório', ranking: 'Ranking', roteiro: 'Roteiro', importar: 'Importar', equipe: 'Equipe', cadastros: 'Cadastros',
};
function abasDoPerfil() {
  if (ehAdmin()) return ['leads', 'distribuir', 'relatorio', 'ranking', 'roteiro', 'importar', 'equipe', 'cadastros'];
  if (ehDiretor()) return ['distribuir', 'relatorio', 'ranking', 'leads', 'roteiro', 'equipe'];
  if (ehSupervisor()) return ['leads', 'distribuir', 'ranking', 'relatorio', 'roteiro', 'equipe'];
  return ['leads', 'roteiro'];
}

function textoQuem() {
  const me = estado.me;
  return ` · ${L.PAPEIS[me.role]}${me.lojaId ? ` · ${nomeLoja(me.lojaId)}` : ''}`;
}

function telaApp() {
  limpar(raiz);
  const abas = abasDoPerfil();
  if (!abas.includes(estado.aba)) estado.aba = abas[0];
  raiz.append(h('div', { class: 'topo' }, h('img', { class: 'topo-rc', src: 'img/logo-rc.png', alt: 'Rede Confia' }), h('img', { class: 'topo-help', src: 'logo.png', alt: 'Help – Loja de Crédito' }),
    h('div', { class: 'quem' },
      h('span', {}, h('b', { text: estado.me.nome }), h('span', { id: 'quem-cargo', text: textoQuem() })),
      h('button', { class: 'btn sec peq', onclick: abrirAlterarSenha, text: 'Alterar senha' }),
      h('button', { class: 'btn sec peq', onclick: () => sair(), text: 'Sair' }))));
  if (abas.length > 1) {
    raiz.append(h('nav', { class: 'abas', id: 'abas', 'aria-label': 'Seções' }, abas.map((a) => h('button', {
      'aria-current': String(a === estado.aba), 'data-aba': a,
      onclick: () => { estado.aba = a; telaApp(); }, text: ABAS[a],
    }))));
  }
  raiz.append(h('div', { id: 'faixa-pend', hidden: true }));
  raiz.append(h('main', { id: 'conteudo' }));
  renderConteudo();
}

function renderConteudo() {
  const c = document.getElementById('conteudo');
  if (!c || !estado.me) return;
  const y = window.scrollY;
  const quem = document.getElementById('quem-cargo');
  if (quem) quem.textContent = textoQuem();
  limpar(c);
  const views = { leads: viewLeads, distribuir: viewDistribuir, relatorio: viewRelatorio, ranking: viewRanking, roteiro: viewRoteiro, importar: viewImportar, equipe: viewEquipe, cadastros: viewCadastros };
  c.append(views[estado.aba]());
  window.scrollTo(0, y);
  atualizarFaixa();
  atualizarCobranca();
}

// ---------- LEADS ----------
function ordemStatus(l) {
  const t = retornoMs(l);
  if (t !== null && t <= Date.now()) return -1; // retorno que já chegou na hora (ou passou) vai para o topo
  return { novo: 0, semcontato: 1, retornar: 2, atendimento: 3, aguardando: 4, proposta: 5, perdido: 6, venda: 7 }[l.status] ?? 9;
}

function leadsFiltrados(ignorarStatus = false) {
  const f = estado.f;
  const busca = L.semAcento(f.busca).toLowerCase().trim();
  const buscaNum = L.soDigitos(f.busca);
  return leadsLista().filter((l) => {
    if (f.produto && l.produtoId !== f.produto) return false;
    if (f.loja && (f.loja === '_sem' ? l.lojaId : l.lojaId !== f.loja)) return false;
    if (f.consultor && (f.consultor === '_sem' ? l.consultorId : l.consultorId !== f.consultor)) return false;
    if (!ignorarStatus && f.status && l.status !== f.status) return false;
    if (busca) {
      const achouNome = L.semAcento(l.nome).toLowerCase().includes(busca);
      const achouCpf = buscaNum.length >= 3 && l.cpf.includes(buscaNum);
      if (!achouNome && !achouCpf) return false;
    }
    return true;
  });
}

function viewLeads() {
  const f = estado.f;
  const base = leadsFiltrados(true);
  const contagem = L.contarStatus(base);
  const lista = base.filter((l) => !f.status || l.status === f.status)
    .sort((a, b) => ordemStatus(a) - ordemStatus(b) || (a.loteId < b.loteId ? 1 : a.loteId > b.loteId ? -1 : 0) || (a.ord ?? 0) - (b.ord ?? 0));
  const distribuidos = base.filter((l) => !l.indicacao && l.lojaId);
  const vendasDist = distribuidos.filter((l) => l.status === 'venda').length;

  const cards = h('div', { class: 'cards' },
    L.STATUS.map((s) => h('button', {
      class: 'card dica-card', 'aria-pressed': String(f.status === s.id), 'data-desc': s.desc,
      onclick: () => { f.status = f.status === s.id ? '' : s.id; f.limite = LINHAS_POR_PAGINA; renderConteudo(); },
    }, h('small', { text: s.nome }), h('strong', { text: contagem[s.id] }))),
    h('div', { class: 'card' }, h('small', { text: 'Conversão' }), h('strong', { text: L.formatarPct(L.conversao(vendasDist, distribuidos.length)) })));

  const selProduto = h('select', { onchange: (e) => { f.produto = e.target.value; f.limite = LINHAS_POR_PAGINA; renderConteudo(); } },
    h('option', { value: '', text: 'Todos os produtos' }), estado.produtos.map((p) => h('option', { value: p.id, text: p.nome, selected: f.produto === p.id })));
  const filtros = [
    h('div', {}, h('label', { text: 'Buscar por nome ou CPF' }), h('input', {
      type: 'search', value: f.busca, placeholder: 'Digite…',
      oninput: (e) => { f.busca = e.target.value; f.limite = LINHAS_POR_PAGINA; clearTimeout(estado.tBusca); estado.tBusca = setTimeout(() => { renderConteudo(); const i = document.querySelector('#conteudo input[type=search]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 300); },
    })),
    h('div', {}, h('label', { text: 'Produto' }), selProduto),
  ];
  if (verTudo()) {
    filtros.push(h('div', {}, h('label', { text: 'Loja' }), h('select', { onchange: (e) => { f.loja = e.target.value; f.consultor = ''; renderConteudo(); } },
      h('option', { value: '', text: 'Todas as lojas' }), h('option', { value: '_sem', text: 'Sem loja (a distribuir)', selected: f.loja === '_sem' }),
      lojasAtivas().map((l) => h('option', { value: l.id, text: l.nome, selected: f.loja === l.id })))));
  }
  if (!ehConsultor()) {
    const consultores = estado.usuarios.filter((u) => u.role === 'consultor' && u.ativo && (!f.loja || f.loja === '_sem' || u.lojaId === f.loja));
    filtros.push(h('div', {}, h('label', { text: 'Consultor' }), h('select', { onchange: (e) => { f.consultor = e.target.value; renderConteudo(); } },
      h('option', { value: '', text: 'Todos' }), h('option', { value: '_sem', text: 'Sem consultor', selected: f.consultor === '_sem' }),
      consultores.map((u) => h('option', { value: u.id, text: u.nome, selected: f.consultor === u.id })))));
  }
  const duplicados = (!ehConsultor()) ? chavesDuplicadas() : new Set();
  const mostrar = lista.slice(0, f.limite);
  const mostrarLoja = verTudo();
  const mostrarConsultor = !ehConsultor();

  const tabela = lista.length ? h('div', { class: 'tabela-wrap' }, h('table', {},
    h('thead', {}, h('tr', {},
      h('th', { text: 'Nome' }), h('th', { text: 'CPF' }), h('th', { text: 'Produto' }), h('th', { text: 'Origem' }),
      mostrarLoja ? h('th', { text: 'Loja' }) : null, mostrarConsultor ? h('th', { text: 'Consultor' }) : null, h('th', { text: 'Situação' }))),
    h('tbody', {}, mostrar.map((l) => h('tr', { class: 'clic', tabindex: '0', onclick: () => abrirFicha(l.id), onkeydown: (e) => { if (e.key === 'Enter') abrirFicha(l.id); } },
      h('td', {}, l.nome, duplicados.has(`${l.produtoId}_${l.cpf}`) ? [' ', h('span', { class: 'tag alerta', text: 'CPF repetido' })] : null),
      h('td', { text: L.mascararCpf(l.cpf) }),
      h('td', {}, h('span', { class: 'tag prod', text: nomeProduto(l.produtoId) })),
      h('td', { text: l.origem || '' }),
      mostrarLoja ? h('td', { text: l.lojaId ? nomeLoja(l.lojaId) : 'A distribuir' }) : null,
      mostrarConsultor ? h('td', { text: l.consultorId ? nomeUsuario(l.consultorId) : '—' }) : null,
      h('td', {}, h('span', { class: `tag ${l.status}`, text: rotuloLead(l) })))))))
    : (estado.leadsPronto ? h('p', { class: 'vazio', text: 'Nenhum lead por aqui.' }) : carregandoLogo('Carregando leads…'));

  return h('div', {}, cards,
    h('div', { class: 'cartao' }, h('div', { class: 'linha' }, filtros),
      ehAdmin() ? h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn sec peq', onclick: () => exportarLeads(lista), text: `Exportar ${lista.length} leads (CSV)` })) : null),
    h('div', { class: 'cartao' }, tabela,
      lista.length > mostrar.length ? h('p', {}, h('button', { class: 'btn sec', onclick: () => { f.limite += LINHAS_POR_PAGINA; renderConteudo(); }, text: `Mostrar mais (${lista.length - mostrar.length} restantes)` })) : null));
}

function chavesDuplicadas() {
  const vistos = new Map();
  for (const l of leadsLista()) { const k = `${l.produtoId}_${l.cpf}`; vistos.set(k, (vistos.get(k) || 0) + 1); }
  return new Set([...vistos].filter(([, n]) => n > 1).map(([k]) => k));
}

function exportarLeads(lista) {
  const cab = ['Nome', 'CPF', 'Telefone', 'Produto', 'Origem', 'Loja', 'Consultor', 'Situação', 'Motivo', 'Observação'];
  const linhas = lista.map((l) => L.linhaCsv([l.nome, l.cpf, l.telefone, nomeProduto(l.produtoId), l.origem, l.lojaId ? nomeLoja(l.lojaId) : '', l.consultorId ? nomeUsuario(l.consultorId) : '', rotuloStatus(l.status), l.motivo, l.obs]));
  baixarCsv(`leads-${hoje()}.csv`, [L.linhaCsv(cab), ...linhas]);
}

// ---------- FICHA DO LEAD ----------
function abrirFicha(leadId) {
  const lead = estado.leadsMap.get(leadId);
  if (!lead) return;
  const podeEditar = L.podeEditarLead(estado.me, lead);
  const mascarar = ehDiretor();
  const dados = [['Produto', nomeProduto(lead.produtoId)], ['Origem', lead.origem || '—']];
  if (lead.indicacao) dados.push(['Indicado por', lead.indicadoPor || '—']);
  dados.push(['CPF', mascarar ? L.mascararCpf(lead.cpf) : L.formatarCpf(lead.cpf)]);
  const tel = lead.telefone;
  const celTel = !tel ? '—' : mascarar ? `(${tel.slice(0, 2)}) *****-${tel.slice(-4)}`
    : h('span', {}, L.formatarTelefone(tel), ' · ',
      h('a', { href: `https://wa.me/55${tel}`, target: '_blank', rel: 'noopener noreferrer', text: 'WhatsApp' }), ' · ',
      h('a', { href: `tel:+55${tel}`, text: 'Ligar' }));
  dados.push(['Telefone', celTel]);
  if (verTudo()) dados.push(['Loja', lead.lojaId ? nomeLoja(lead.lojaId) : 'A distribuir']);
  if (!ehConsultor()) dados.push(['Consultor', lead.consultorId ? nomeUsuario(lead.consultorId) : '—']);
  for (const [k, v] of Object.entries(lead.extras || {})) dados.push([k, v]);

  const corpo = h('div', {}, h('dl', { class: 'dados' }, dados.map(([k, v]) => [h('dt', { text: k }), h('dd', {}, v)])));
  const histLista = (lead.hist || []).slice(-6).reverse();
  let m;

  if (!podeEditar) {
    if (lead.status) corpo.append(h('p', {}, 'Situação: ', h('span', { class: `tag ${lead.status}`, text: rotuloLead(lead) })));
    if (lead.obs) corpo.append(h('p', { text: `Observação: ${lead.obs}` }));
    if (lead.motivo) corpo.append(h('p', { text: `Motivo: ${lead.motivo}` }));
    if (histLista.length) corpo.append(blocoHistorico(histLista));
    m = abrirModal(lead.nome, corpo);
    return;
  }

  const sel = { status: lead.status };
  const botoesStatus = L.STATUS.map((s) => h('button', {
    type: 'button', 'aria-pressed': String(sel.status === s.id), 'data-status': s.id, 'data-desc': s.desc, class: 'dica-card',
    onclick: () => { sel.status = s.id; botoesStatus.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === s.id))); atualizarCampos(); },
    text: s.nome,
  }));
  const obs = h('textarea', { maxlength: '500', value: lead.obs || '' });
  const motivo = h('input', { type: 'text', maxlength: '120', value: lead.motivo || '' });
  const dataVenda = h('input', { type: 'date', value: lead.vendaEm || hoje() });
  const blocoMotivo = h('div', {}, campo('Motivo (obrigatório)', motivo));
  const dataRetorno = h('input', { type: 'date', value: lead.retornarEm || '', min: hoje() });
  const horaRetorno = h('input', { type: 'time', value: lead.retornarHora || '09:00' });
  const blocoRetorno = h('div', {}, h('div', { class: 'linha' }, campo('Dia (obrigatório)', dataRetorno), campo('Hora (obrigatório)', horaRetorno)),
    h('p', { class: 'dica', text: 'Na hora marcada o painel mostra um aviso (com o painel aberto no navegador, mesmo em outra aba).' }));
  const textoStatus = h('p', { class: 'dica', 'aria-live': 'polite' });
  const jaTinhaIndic = (lead.indicacoes || []).length >= L.TOTAL_INDICACOES;
  const itensInd = Array.from({ length: L.TOTAL_INDICACOES }, (_, i) => {
    const ex = (lead.indicacoes || [])[i] || {};
    return {
      nome: h('input', { type: 'text', maxlength: '120', placeholder: 'Nome', 'aria-label': `Indicação ${i + 1}: nome`, value: ex.nome || '' }),
      cpf: h('input', { type: 'text', inputmode: 'numeric', maxlength: '14', placeholder: 'CPF', 'aria-label': `Indicação ${i + 1}: CPF`, value: ex.cpf ? L.formatarCpf(ex.cpf) : '' }),
      tel: h('input', { type: 'tel', maxlength: '16', placeholder: 'Telefone (opcional)', 'aria-label': `Indicação ${i + 1}: telefone`, value: ex.telefone ? L.formatarTelefone(ex.telefone) : '' }),
      erro: h('small', { hidden: true }),
    };
  });
  const blocoVenda = h('div', {},
    campo('Data da venda', dataVenda),
    h('div', { class: 'indic' }, h('b', { text: `Quem mais esse cliente indica? Informe ${L.TOTAL_INDICACOES} pessoas (nome e CPF).` }),
      h('p', { class: 'dica', text: 'Elas viram novos leads para você trabalhar.' }),
      itensInd.map((it) => h('div', { class: 'item' }, it.nome, it.cpf, it.tel, it.erro))));
  const erroGeral = h('div', { class: 'erro', hidden: true, role: 'alert' });

  function atualizarCampos() {
    blocoMotivo.hidden = sel.status !== 'perdido';
    blocoRetorno.hidden = sel.status !== 'retornar';
    textoStatus.textContent = descStatus(sel.status);
    blocoVenda.hidden = sel.status !== 'venda';
  }
  atualizarCampos();

  const botaoSalvar = h('button', { class: 'btn', text: 'Salvar' });
  botaoSalvar.addEventListener('click', async () => {
    erroGeral.hidden = true;
    itensInd.forEach((it) => { it.erro.hidden = true; });
    const upd = { status: sel.status, obs: L.limparTexto(obs.value).slice(0, 500), motivo: '', vendaEm: '', retornarEm: '', retornarHora: '', atualizadoEm: serverTimestamp() };
    if (sel.status === 'retornar') {
      if (!dataRetorno.value || !horaRetorno.value) { erroGeral.textContent = 'Informe o dia e a hora do retorno.'; erroGeral.hidden = false; return; }
      if (new Date(`${dataRetorno.value}T${horaRetorno.value}:00`).getTime() < Date.now() - 60000) { erroGeral.textContent = 'Escolha um dia e hora que ainda não passaram.'; erroGeral.hidden = false; return; }
      upd.retornarEm = dataRetorno.value;
      upd.retornarHora = horaRetorno.value;
      pedirPermissaoAvisos();
    }
    let indicacoesNovas = null;
    if (sel.status === 'perdido') {
      upd.motivo = L.limparTexto(motivo.value).slice(0, 120);
      if (upd.motivo.length < 3) { erroGeral.textContent = 'Informe o motivo (mínimo 3 letras).'; erroGeral.hidden = false; return; }
    }
    if (sel.status === 'venda') {
      if (!dataVenda.value) { erroGeral.textContent = 'Informe a data da venda.'; erroGeral.hidden = false; return; }
      upd.vendaEm = dataVenda.value;
      const v = L.validarIndicacoes(itensInd.map((it) => ({ nome: it.nome.value, cpf: it.cpf.value, telefone: it.tel.value })), lead.cpf);
      if (!v.ok) {
        v.erros.forEach((e, i) => { if (e) { itensInd[i].erro.textContent = e; itensInd[i].erro.hidden = false; } });
        erroGeral.textContent = `Para fechar a venda, preencha as ${L.TOTAL_INDICACOES} indicações corretamente.`;
        erroGeral.hidden = false;
        return;
      }
      upd.indicacoes = v.itens;
      if (!jaTinhaIndic) indicacoesNovas = v.itens;
    }
    const entrada = { em: new Date().toISOString(), por: estado.me.nome, st: sel.status };
    if (upd.obs) entrada.obs = upd.obs.slice(0, 120);
    upd.hist = [...(lead.hist || []), entrada].slice(-30);
    botaoSalvar.disabled = true;
    try {
      await updateDoc(doc(db, 'leads', lead.id), upd);
      let criadas = 0;
      let jaExistiam = 0;
      // Cada indicação usa o mesmo id de um lead importado (produto + CPF): se o CPF já está na base, não duplica.
      for (const [i, it] of (indicacoesNovas || []).entries()) {
        const idNovo = L.idLead(lead.produtoId, it.cpf);
        if (estado.leadsMap.has(idNovo)) { jaExistiam++; continue; }
        try {
          await setDoc(doc(db, 'leads', idNovo), {
            nome: it.nome, cpf: it.cpf, telefone: it.telefone, produtoId: lead.produtoId, loteId: 'indicacoes',
            origem: `Indicação de ${lead.nome}`, extras: {}, ord: i, lojaId: lead.lojaId || null, consultorId: lead.consultorId || null,
            status: 'novo', motivo: '', obs: '', vendaEm: '', indicacoes: [], indicacao: true, indicadoPor: lead.nome, indicadoDe: lead.id,
            criadoEm: serverTimestamp(), hist: [],
          });
          criadas++;
        } catch (e) {
          // o consultor não enxerga leads de outras pessoas: negado aqui significa que o CPF já existe na base
          console.error('indicacao', e?.code || e);
          jaExistiam++;
        }
      }
      m.fechar();
      if (!indicacoesNovas) aviso('Lead atualizado.');
      else if (!jaExistiam) aviso('Venda registrada. As 3 indicações viraram novos leads.');
      else aviso(`Venda registrada. ${criadas} indicação(ões) viraram leads; ${jaExistiam} já estava(m) na base e não foi(ram) duplicada(s).`);
    } catch (e) {
      console.error('salvar lead', e?.code || e);
      erroGeral.textContent = 'Não consegui salvar. Confira a conexão e tente de novo.';
      erroGeral.hidden = false;
      botaoSalvar.disabled = false;
    }
  });

  corpo.append(
    h('label', { text: 'Situação' }), h('div', { class: 'status-opcoes' }, botoesStatus), textoStatus,
    blocoRetorno, blocoMotivo, blocoVenda, campo('Observação', obs), erroGeral);

  if (ehSupervisor() || ehAdmin()) corpo.append(blocoReatribuir(lead, () => m.fechar()));
  if (histLista.length) corpo.append(blocoHistorico(histLista));
  corpo.append(h('div', { class: 'acoes' }, h('button', { class: 'btn sec', onclick: () => m.fechar(), text: 'Cancelar' }), botaoSalvar));
  m = abrirModal(lead.nome, corpo);
}

function blocoHistorico(itens) {
  return h('ul', { class: 'hist' }, itens.map((e) => h('li', { text: `${new Date(e.em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · ${e.por} · ${rotuloStatus(e.st)}${e.obs ? ` · ${e.obs}` : ''}` })));
}

function blocoReatribuir(lead, fechar) {
  const lojaId = lead.lojaId;
  const opcoes = lojaId ? consultoresDaLoja(lojaId) : [];
  const sel = h('select', {},
    h('option', { value: '', text: 'Sem consultor (volta para a loja)' }),
    opcoes.map((u) => h('option', { value: u.id, text: u.nome, selected: lead.consultorId === u.id })));
  const salvar = h('button', {
    class: 'btn sec peq', text: 'Mover',
    onclick: async () => {
      salvar.disabled = true;
      try {
        await updateDoc(doc(db, 'leads', lead.id), { consultorId: sel.value || null, atribuidoEm: serverTimestamp() });
        aviso('Responsável atualizado.');
        fechar();
      } catch (e) { console.error('mover', e?.code || e); aviso('Não consegui mover o lead.', 'erro'); salvar.disabled = false; }
    },
  });
  if (!lojaId) return h('p', { class: 'dica', text: 'Este lead ainda não foi enviado para uma loja.' });
  return h('div', { style: 'margin-top:14px' }, h('label', { text: 'Responsável' }), h('div', { class: 'linha' }, sel, h('div', { class: 'fixo' }, salvar)));
}

// ---------- DISTRIBUIR ----------
async function gravarEmLotes(operacoes) {
  for (let i = 0; i < operacoes.length; i += TAMANHO_LOTE_ESCRITA) {
    const b = writeBatch(db);
    operacoes.slice(i, i + TAMANHO_LOTE_ESCRITA).forEach(([ref, dados, tipo]) => { if (tipo === 'set') b.set(ref, dados); else b.update(ref, dados); });
    await b.commit();
  }
}

function viewDistribuir() {
  const d = estado.dist;
  const me = estado.me;
  const modo = ehDiretor() ? 'lojas' : ehSupervisor() ? 'consultores' : d.modo;
  const lojaAlvo = ehSupervisor() ? me.lojaId : (d.loja || lojasAtivas()[0]?.id || '');
  const reais = leadsLista().filter((l) => !l.indicacao);
  const pool = modo === 'lojas'
    ? reais.filter((l) => !l.lojaId && (!d.lote || l.loteId === d.lote))
    : reais.filter((l) => l.lojaId === lojaAlvo && !l.consultorId);
  const disp = {};
  pool.forEach((l) => { disp[l.produtoId] = (disp[l.produtoId] || 0) + 1; });
  const colunas = estado.produtos.filter((p) => disp[p.id]);
  const alvos = modo === 'lojas'
    ? lojasAtivas().map((l) => ({ id: l.id, nome: l.nome, sub: supervisorDaLoja(l.id)?.nome || 'sem supervisor' }))
    : consultoresDaLoja(lojaAlvo).map((u) => ({ id: u.id, nome: u.nome, sub: '' }));

  const quadro = verTudo() ? quadroPendencias() : null;
  const topo = h('div', { class: 'cartao' });
  const controles = [];
  if (ehAdmin()) {
    controles.push(h('div', {}, h('label', { text: 'Distribuir para' }), h('select', { onchange: (e) => { d.modo = e.target.value; d.plano = {}; renderConteudo(); } },
      h('option', { value: 'lojas', text: 'Lojas (da base geral)', selected: modo === 'lojas' }), h('option', { value: 'consultores', text: 'Consultores de uma loja', selected: modo === 'consultores' }))));
  }
  if (modo === 'consultores' && ehAdmin()) {
    controles.push(h('div', {}, h('label', { text: 'Loja' }), h('select', { onchange: (e) => { d.loja = e.target.value; d.plano = {}; renderConteudo(); } },
      lojasAtivas().map((l) => h('option', { value: l.id, text: l.nome, selected: l.id === lojaAlvo })))));
  }
  if (modo === 'lojas') {
    controles.push(h('div', {}, h('label', { text: 'Lote (opcional)' }), h('select', { onchange: (e) => { d.lote = e.target.value; d.plano = {}; renderConteudo(); } },
      h('option', { value: '', text: 'Todos os lotes' }), estado.lotes.map((l) => h('option', { value: l.id, text: l.nome, selected: d.lote === l.id })))));
  }
  topo.append(h('h2', { text: modo === 'lojas' ? 'Enviar leads para as lojas' : 'Passar leads para os consultores' }),
    ...(controles.length ? [h('div', { class: 'linha' }, controles)] : []));

  if (!estado.leadsPronto) return h('div', {}, topo, carregandoLogo());
  if (!colunas.length) return h('div', {}, quadro, topo, h('div', { class: 'cartao' }, h('p', { class: 'vazio', text: modo === 'lojas' ? 'Nenhum lead esperando distribuição.' : 'Nenhum lead da loja esperando por consultor.' })));
  if (!alvos.length) return h('div', {}, quadro, topo, h('div', { class: 'cartao' }, h('p', { class: 'vazio', text: 'Não há destinatários ativos cadastrados.' })));

  const plano = d.plano;
  const valorCelula = (alvoId, prod) => plano[alvoId]?.[prod] ?? 0;
  const celulas = new Map();
  const totaisRodape = new Map();
  const sobraRodape = new Map();
  const totaisLinha = new Map();
  const botaoEnviar = h('button', { class: 'btn', text: 'Enviar' });

  function recalcular() {
    const soma = {};
    colunas.forEach((p) => { soma[p.id] = 0; });
    alvos.forEach((a) => colunas.forEach((p) => { soma[p.id] += valorCelula(a.id, p.id); }));
    let total = 0; let erro = false;
    colunas.forEach((p) => {
      total += soma[p.id];
      totaisRodape.get(p.id).textContent = soma[p.id];
      const sobra = disp[p.id] - soma[p.id];
      sobraRodape.get(p.id).textContent = sobra;
      if (sobra < 0) erro = true;
      alvos.forEach((a) => celulas.get(`${a.id}|${p.id}`).classList.toggle('acima', sobra < 0));
    });
    alvos.forEach((a) => { totaisLinha.get(a.id).textContent = colunas.reduce((s, p) => s + valorCelula(a.id, p.id), 0); });
    botaoEnviar.disabled = erro || total === 0;
    botaoEnviar.textContent = total ? `Enviar ${total} leads` : 'Enviar';
  }

  const tabela = h('div', { class: 'tabela-wrap' }, h('table', { class: 'dist' },
    h('thead', {}, h('tr', {}, h('th', { text: modo === 'lojas' ? 'Loja' : 'Consultor' }),
      colunas.map((p) => h('th', { class: 'num' }, p.nome, h('br'), h('small', { text: `${disp[p.id]} disponíveis` }))), h('th', { class: 'num', text: 'Total' }))),
    h('tbody', {}, alvos.map((a) => h('tr', {},
      h('td', {}, a.nome, a.sub ? h('div', { class: 'dica', text: `Supervisor: ${a.sub}` }) : null),
      colunas.map((p) => {
        const inp = h('input', {
          type: 'number', min: '0', max: String(disp[p.id]), step: '1', value: valorCelula(a.id, p.id) || '', inputmode: 'numeric',
          'aria-label': `${a.nome}: ${p.nome}`,
          oninput: (e) => { const n = Math.max(0, Math.floor(Number(e.target.value) || 0)); (plano[a.id] ??= {})[p.id] = n; recalcular(); },
        });
        celulas.set(`${a.id}|${p.id}`, inp);
        return h('td', { class: 'num' }, inp);
      }),
      (() => { const td = h('td', { class: 'num', text: '0' }); totaisLinha.set(a.id, td); return td; })())),
    h('tr', { class: 'rodape-dist' }, h('td', { text: 'Distribuindo' }), colunas.map((p) => { const td = h('td', { class: 'num', text: '0' }); totaisRodape.set(p.id, td); return td; }), h('td')),
    h('tr', { class: 'rodape-dist' }, h('td', { text: 'Sobra' }), colunas.map((p) => { const td = h('td', { class: 'num', text: String(disp[p.id]) }); sobraRodape.set(p.id, td); return td; }), h('td')))));

  const dividir = h('button', {
    class: 'btn sec', text: 'Dividir tudo igualmente',
    onclick: () => {
      d.plano = {};
      colunas.forEach((p) => dividirPara(p));
      renderConteudo();
    },
  });
  function dividirPara(p) {
    L.dividirIgual(disp[p.id], alvos.length).forEach((q, i) => { (d.plano[alvos[i].id] ??= {})[p.id] = q; });
  }
  const zerar = h('button', { class: 'btn sec', text: 'Zerar', onclick: () => { d.plano = {}; renderConteudo(); } });

  botaoEnviar.addEventListener('click', async () => {
    const v = L.validarPlano(plano, disp);
    if (!v.ok) { aviso(v.erro, 'erro'); return; }
    const porProduto = {};
    colunas.forEach((p) => { porProduto[p.id] = pool.filter((l) => l.produtoId === p.id).sort((a, b) => (a.loteId < b.loteId ? -1 : a.loteId > b.loteId ? 1 : 0) || (a.ord ?? 0) - (b.ord ?? 0)); });
    const lista = L.fatiarDistribuicao(porProduto, plano, alvos.map((a) => a.id));
    const destino = modo === 'lojas' ? 'lojas' : 'consultores';
    if (!(await confirmar('Confirmar envio', `Enviar ${lista.length} leads para ${destino}?`, 'Enviar'))) return;
    botaoEnviar.disabled = true;
    try {
      const ops = lista.map((x) => [doc(db, 'leads', x.leadId), modo === 'lojas' ? { lojaId: x.alvoId, enviadoEm: serverTimestamp() } : { consultorId: x.alvoId, atribuidoEm: serverTimestamp() }, 'update']);
      await gravarEmLotes(ops);
      d.plano = {};
      aviso(`${lista.length} leads enviados.`);
    } catch (e) {
      console.error('distribuir', e?.code || e);
      aviso('A distribuição foi interrompida. Confira o que já foi enviado e repita o restante.', 'erro');
    }
    renderConteudo();
  });

  setTimeout(recalcular, 0);
  return h('div', {}, quadro, topo, h('div', { class: 'cartao' }, tabela,
    h('div', { class: 'acoes', style: 'display:flex;gap:10px;flex-wrap:wrap;margin-top:14px' }, dividir, zerar, h('span', { style: 'flex:1' }), botaoEnviar)));
}

// ---------- RELATÓRIO ----------
function viewRelatorio() {
  const r = estado.rel;
  const rel = L.montarRelatorio(leadsLista(), { produtoId: r.produto, loteId: r.lote });
  const semLoja = verTudo() ? leadsLista().filter((l) => !l.indicacao && !l.lojaId && (!r.produto || l.produtoId === r.produto) && (!r.lote || l.loteId === r.lote)).length : 0;

  const filtros = h('div', { class: 'cartao' }, h('div', { class: 'linha' },
    h('div', {}, h('label', { text: 'Produto' }), h('select', { onchange: (e) => { r.produto = e.target.value; renderConteudo(); } },
      h('option', { value: '', text: 'Todos os produtos' }), estado.produtos.map((p) => h('option', { value: p.id, text: p.nome, selected: r.produto === p.id })))),
    verTudo() ? h('div', {}, h('label', { text: 'Lote' }), h('select', { onchange: (e) => { r.lote = e.target.value; renderConteudo(); } },
      h('option', { value: '', text: 'Todos os lotes' }), estado.lotes.map((l) => h('option', { value: l.id, text: l.nome, selected: r.lote === l.id })))) : null,
    h('div', { class: 'fixo' }, h('button', { class: 'btn sec', onclick: () => exportarRelatorio(), text: 'Exportar relatório (CSV)' }))));
  const exportarRelatorio = () => {
    const pct = (v) => L.formatarPct(v);
    const loteNome = r.lote ? (estado.lotes.find((l) => l.id === r.lote)?.nome || '') : 'Todos os lotes';
    const saida = [L.linhaCsv(['Relatório de leads · Rede Confia']), L.linhaCsv(['Produto', r.produto ? nomeProduto(r.produto) : 'Todos os produtos']),
      ...(verTudo() ? [L.linhaCsv(['Lote', loteNome])] : []), L.linhaCsv(['Gerado em', agoraBr()]), '',
      L.linhaCsv(['Leads enviados', 'Vendas', 'Conversão']), L.linhaCsv([rel.geral.leads, rel.geral.vendas, pct(rel.geral.conv)]), ''];
    if (!r.produto && rel.produtos.length) {
      saida.push(L.linhaCsv(['Produto', 'Leads', 'Vendas', 'Conversão']), ...rel.produtos.map((p) => L.linhaCsv([nomeProduto(p.id), p.leads, p.vendas, pct(p.conv)])), '');
    }
    if (dadosLojas) {
      saida.push(L.linhaCsv(['Loja', 'Supervisor', 'Leads', 'Vendas', 'Conversão', ...dadosLojas.colunas.map((p) => `${p.nome} (vendas/leads)`), 'Indicações geradas', 'Vendas das indicações']),
        ...dadosLojas.linhas.map((l) => L.linhaCsv([nomeLoja(l.id), supervisorDaLoja(l.id)?.nome || '', l.leads, l.vendas, pct(l.conv),
          ...dadosLojas.colunas.map((p) => (l.porProduto[p.id]?.leads ? `${l.porProduto[p.id].vendas}/${l.porProduto[p.id].leads}` : '')), l.indic.leads, l.indic.vendas])), '');
    }
    saida.push(L.linhaCsv(['Consultor', ...(verTudo() ? ['Loja'] : []), 'Leads', 'Vendas', 'Conversão', 'Indicações geradas', 'Vendas das indicações']),
      ...dadosConsultores.map((c) => L.linhaCsv([c.u.nome, ...(verTudo() ? [nomeLoja(c.u.lojaId)] : []), c.leads, c.vendas, pct(c.conv), c.indic.leads, c.indic.vendas])));
    baixarCsv(`relatorio-${hoje()}.csv`, saida);
  };
  let dadosLojas = null;
  let dadosConsultores = [];

  const cards = h('div', { class: 'cards' },
    h('div', { class: 'card' }, h('small', { text: 'Leads enviados' }), h('strong', { text: rel.geral.leads })),
    h('div', { class: 'card' }, h('small', { text: 'Vendas' }), h('strong', { text: rel.geral.vendas })),
    h('div', { class: 'card' }, h('small', { text: 'Conversão' }), h('strong', { text: L.formatarPct(rel.geral.conv) })),
    semLoja ? h('div', { class: 'card' }, h('small', { text: 'A distribuir' }), h('strong', { text: semLoja })) : null);

  const celulaConv = (t) => (t && t.leads ? `${L.formatarPct(t.conv)} (${t.vendas}/${t.leads})` : '–');
  const barra = (conv) => h('span', { class: 'barra', 'aria-hidden': 'true' }, h('i', { style: `width:${Math.round((conv || 0) * 100)}%` }));
  const indicTxt = (i) => (i && i.leads ? `${i.leads} / ${i.vendas}` : '–');

  const secoes = [filtros, cards];

  // por produto
  if (!r.produto && rel.produtos.length) {
    const melhor = rel.produtos[0];
    secoes.push(h('div', { class: 'cartao' }, h('h3', { text: melhor.conv ? `${nomeProduto(melhor.id)} converte melhor: ${L.formatarPct(melhor.conv)}` : 'Conversão por produto' }),
      h('div', { class: 'tabela-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { text: 'Produto' }), h('th', { class: 'num', text: 'Leads' }), h('th', { class: 'num', text: 'Vendas' }), h('th', { class: 'num', text: 'Conversão' }))),
        h('tbody', {}, rel.produtos.map((p) => h('tr', {}, h('td', { text: nomeProduto(p.id) }), h('td', { class: 'num', text: p.leads }), h('td', { class: 'num', text: p.vendas }), h('td', { class: 'num' }, L.formatarPct(p.conv), barra(p.conv)))))))));
  }

  // por loja (diretoria / admin) — loja e supervisor são a mesma linha
  if (verTudo()) {
    const porId = new Map(rel.lojas.map((l) => [l.id, l]));
    const linhas = lojasAtivas().map((l) => porId.get(l.id) || { id: l.id, leads: 0, vendas: 0, conv: null, porProduto: {}, indic: { leads: 0, vendas: 0 } })
      .sort((a, b) => (b.conv ?? -1) - (a.conv ?? -1) || b.leads - a.leads);
    const colunasProd = (r.produto ? estado.produtos.filter((p) => p.id === r.produto) : produtosAtivos());
    const melhorPorProduto = {};
    colunasProd.forEach((p) => {
      const max = Math.max(0, ...linhas.map((l) => l.porProduto[p.id]?.conv ?? 0));
      melhorPorProduto[p.id] = max;
    });
    dadosLojas = { linhas, colunas: colunasProd };
    const melhorLoja = linhas.find((l) => l.leads > 0);
    secoes.push(h('div', { class: 'cartao' },
      h('h3', { text: melhorLoja && melhorLoja.conv ? `${nomeLoja(melhorLoja.id)} converte melhor: ${L.formatarPct(melhorLoja.conv)}` : 'Conversão por loja' }),
      h('p', { class: 'dica', text: 'Em verde, a melhor loja em cada produto. Indicações: leads gerados / vendas deles (não entram na conversão).' }),
      h('div', { class: 'tabela-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { text: 'Loja (supervisor)' }), h('th', { class: 'num', text: 'Leads' }), h('th', { class: 'num', text: 'Vendas' }), h('th', { class: 'num', text: 'Conversão' }),
          colunasProd.map((p) => h('th', { class: 'num', text: p.nome })), h('th', { class: 'num', text: 'Indicações' }))),
        h('tbody', {}, linhas.map((l) => h('tr', {},
          h('td', {}, nomeLoja(l.id), h('div', { class: 'dica', text: supervisorDaLoja(l.id)?.nome || '' })),
          h('td', { class: 'num', text: l.leads }), h('td', { class: 'num', text: l.vendas }),
          h('td', { class: 'num' }, L.formatarPct(l.conv), barra(l.conv)),
          colunasProd.map((p) => {
            const t = l.porProduto[p.id];
            const eMelhor = t && t.leads > 0 && melhorPorProduto[p.id] > 0 && t.conv === melhorPorProduto[p.id];
            return h('td', { class: `num${eMelhor ? ' melhor' : ''}`, text: celulaConv(t) });
          }),
          h('td', { class: 'num', text: indicTxt(l.indic) }))))))));
  }

  // por consultor
  const consultores = verTudo() ? estado.usuarios.filter((u) => u.role === 'consultor' && u.ativo) : estado.usuarios.filter((u) => u.role === 'consultor' && u.ativo && u.lojaId === estado.me.lojaId);
  const mapaC = new Map(rel.consultores.map((c) => [c.id, c]));
  const linhasC = consultores.map((u) => ({ u, ...(mapaC.get(u.id) || { leads: 0, vendas: 0, conv: null, indic: { leads: 0, vendas: 0 } }) }))
    .sort((a, b) => (b.conv ?? -1) - (a.conv ?? -1) || b.leads - a.leads);
  dadosConsultores = linhasC;
  if (!verTudo() && rel.lojas[0]) {
    secoes.push(h('div', { class: 'cartao' }, h('h3', { text: `Conversão da loja: ${L.formatarPct(rel.lojas[0].conv)}` })));
  }
  secoes.push(h('div', { class: 'cartao' }, h('h3', { text: 'Conversão por consultor' }),
    linhasC.length ? h('div', { class: 'tabela-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'Consultor' }), verTudo() ? h('th', { text: 'Loja' }) : null, h('th', { class: 'num', text: 'Leads' }), h('th', { class: 'num', text: 'Vendas' }), h('th', { class: 'num', text: 'Conversão' }), h('th', { class: 'num', text: 'Indicações' }))),
      h('tbody', {}, linhasC.map((c) => h('tr', {}, h('td', { text: c.u.nome }), verTudo() ? h('td', { text: nomeLoja(c.u.lojaId) }) : null,
        h('td', { class: 'num', text: c.leads }), h('td', { class: 'num', text: c.vendas }), h('td', { class: 'num' }, L.formatarPct(c.conv), barra(c.conv)), h('td', { class: 'num', text: indicTxt(c.indic) })))))) : h('p', { class: 'vazio', text: 'Nenhum consultor cadastrado.' })));
  return h('div', {}, secoes);
}

// ---------- RANKING ----------
function viewRanking() {
  const k = estado.rank;
  const modo = ehAdmin() ? k.modo : verTudo() ? 'lojas' : 'consultores';
  const desde = k.periodo === 'hoje' ? hoje() : k.periodo === 'mes' ? `${hoje().slice(0, 8)}01` : '';
  const consultores = estado.usuarios.filter((u) => u.role === 'consultor' && u.ativo && (verTudo() || u.lojaId === estado.me.lojaId));
  const itens = modo === 'lojas' ? lojasAtivas().map((l) => l.id) : consultores.map((u) => u.id);
  const lista = L.montarRanking(leadsLista(), { chave: modo === 'lojas' ? 'lojaId' : 'consultorId', itens, produtoId: k.produto, desde });
  const nome = (id) => (modo === 'lojas' ? nomeLoja(id) : nomeUsuario(id));
  const sub = (id) => (modo === 'lojas' ? (supervisorDaLoja(id)?.nome || '') : (verTudo() ? nomeLoja(estado.usuarios.find((u) => u.id === id)?.lojaId) : ''));
  const periodoTxt = { hoje: 'hoje', mes: 'neste mês', tudo: 'no total' }[k.periodo];

  const filtros = h('div', { class: 'cartao' }, h('div', { class: 'linha' },
    ehAdmin() ? campo('Ranking de', h('select', { onchange: (e) => { k.modo = e.target.value; renderConteudo(); } },
      h('option', { value: 'lojas', text: 'Lojas', selected: k.modo === 'lojas' }), h('option', { value: 'consultores', text: 'Consultores', selected: k.modo === 'consultores' }))) : null,
    campo('Período', h('select', { onchange: (e) => { k.periodo = e.target.value; renderConteudo(); } },
      h('option', { value: 'hoje', text: 'Hoje', selected: k.periodo === 'hoje' }), h('option', { value: 'mes', text: 'Este mês', selected: k.periodo === 'mes' }), h('option', { value: 'tudo', text: 'Tudo', selected: k.periodo === 'tudo' }))),
    campo('Produto', h('select', { onchange: (e) => { k.produto = e.target.value; renderConteudo(); } },
      h('option', { value: '', text: 'Todos os produtos' }), estado.produtos.map((p) => h('option', { value: p.id, text: p.nome, selected: k.produto === p.id }))))));

  const titulo = h('h2', { text: modo === 'lojas' ? 'Ranking das lojas' : `Ranking dos consultores${verTudo() ? '' : ` · ${nomeLoja(estado.me.lojaId)}`}` });
  if (!lista.length) return h('div', {}, filtros, h('div', { class: 'cartao' }, titulo, h('p', { class: 'vazio', text: modo === 'lojas' ? 'Nenhuma loja cadastrada.' : 'Nenhum consultor cadastrado.' })));

  const medalha = (p) => `${p}º`;
  const comVendas = lista[0].vendas > 0;
  const topo = lista.filter((x) => x.posicao <= 3).slice(0, 3);
  // pódio: 2º à esquerda, 1º no meio, 3º à direita
  const ordemPodio = comVendas ? [topo.find((x) => x.posicao === 2), topo.find((x) => x.posicao === 1), topo.find((x) => x.posicao === 3)].filter(Boolean) : [];
  const podio = comVendas ? h('div', { class: 'podio', role: 'list' }, ordemPodio.map((x) => h('div', { class: `podio-item p${x.posicao}`, role: 'listitem' },
    h('div', { class: 'podio-nome' }, h('b', { text: nome(x.id) }), h('small', { text: sub(x.id) })),
    h('div', { class: 'podio-bloco' }, h('span', { class: 'podio-pos', text: medalha(x.posicao) }), h('strong', { text: x.vendas }), h('small', { text: x.vendas === 1 ? 'venda' : 'vendas' }))))) : null;
  const noPodio = new Set(ordemPodio.map((x) => x.id));
  const resto = comVendas ? lista.filter((x) => !noPodio.has(x.id)) : lista;
  const tabela = resto.length ? h('div', { class: 'tabela-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', { text: '#' }), h('th', { text: modo === 'lojas' ? 'Loja' : 'Consultor' }), h('th', { class: 'num', text: 'Vendas' }), h('th', { class: 'num', text: 'Leads' }), h('th', { class: 'num', text: 'Conversão' }))),
    h('tbody', {}, resto.map((x) => h('tr', {},
      h('td', { text: medalha(x.posicao) }),
      h('td', {}, nome(x.id), sub(x.id) ? h('div', { class: 'dica', text: sub(x.id) }) : null),
      h('td', { class: 'num', text: x.vendas }), h('td', { class: 'num', text: x.leads }), h('td', { class: 'num', text: L.formatarPct(x.conv) }))))) ) : null;
  return h('div', {}, filtros, h('div', { class: 'cartao' }, titulo,
    h('p', { class: 'dica', text: `Vendas ${periodoTxt}. Empate: maior conversão (vendas ÷ leads recebidos).` }),
    comVendas ? null : h('p', { class: 'vazio', text: `Ainda não há vendas ${periodoTxt}.` }), podio, tabela));
}

// ---------- ROTEIRO (material de consulta, todos os perfis; só o Admin publica) ----------
function idbAbrir() {
  return new Promise((ok, falha) => {
    const r = indexedDB.open('painel-roteiros', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('r');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => falha(r.error);
  });
}
async function idbLer(k) {
  try {
    const d = await idbAbrir();
    return await new Promise((ok) => { const q = d.transaction('r').objectStore('r').get(k); q.onsuccess = () => ok(q.result || null); q.onerror = () => ok(null); });
  } catch { return null; }
}
async function idbGravar(k, v) {
  try {
    const d = await idbAbrir();
    await new Promise((ok) => { const t = d.transaction('r', 'readwrite'); t.objectStore('r').put(v, k); t.oncomplete = ok; t.onerror = ok; });
  } catch { /* sem cache: busca de novo na próxima vez */ }
}

async function carregarRoteiro(meta) {
  const r = estado.rot;
  const chave = `${meta.id}:${meta.versao}`;
  if (r.chave === chave && r.paginas) return;
  if (r.carregando === chave) return;
  r.carregando = chave; r.erro = false;
  try {
    let paginas = await idbLer(chave);
    if (!paginas) {
      const s = await getDocs(query(collection(db, 'roteiro_paginas'), where('roteiroId', '==', meta.id), where('v', '==', meta.versao)));
      paginas = s.docs.map((d) => d.data()).sort((x, y) => x.n - y.n).map((p) => ({ n: p.n, img: p.img, texto: p.texto || '' }));
      if (paginas.length) await idbGravar(chave, paginas);
    }
    if (!paginas.length) throw new Error('vazio');
    r.paginas = paginas; r.chave = chave; r.pagina = 1; r.busca = '';
  } catch (e) {
    console.error('roteiro', e?.code || e);
    r.erro = true;
  }
  r.carregando = false;
  agendarRender();
}

function viewRoteiro() {
  const r = estado.rot;
  const ad = ehAdmin();
  const botoesAdmin = (meta) => (ad ? h('div', { class: 'linha', style: 'margin-bottom:12px' },
    h('button', { class: 'btn sec peq', onclick: () => abrirPublicarRoteiro(null), text: 'Novo roteiro (PDF)' }),
    meta ? [h('button', { class: 'btn sec peq', onclick: () => abrirPublicarRoteiro(meta), text: 'Atualizar este roteiro (PDF)' }),
      h('button', { class: 'btn sec peq', onclick: () => excluirRoteiro(meta), text: 'Excluir' })] : null) : null);

  if (!estado.roteiros.length) {
    return h('div', { class: 'cartao' }, h('h2', { text: 'Roteiro' }), botoesAdmin(null),
      h('p', { class: 'vazio', text: ad ? 'Nenhum roteiro publicado ainda. Use "Novo roteiro (PDF)".' : 'Nenhum roteiro publicado ainda.' }));
  }
  if (!estado.roteiros.some((x) => x.id === r.id)) { r.id = estado.roteiros[0].id; r.paginas = null; r.chave = ''; }
  const meta = estado.roteiros.find((x) => x.id === r.id);
  const seletor = estado.roteiros.length > 1 ? h('div', { class: 'abas-roteiro' }, estado.roteiros.map((x) => h('button', {
    'aria-pressed': String(x.id === r.id), text: x.titulo,
    onclick: () => { r.id = x.id; r.paginas = null; r.chave = ''; r.pagina = 1; r.busca = ''; renderConteudo(); },
  }))) : null;
  const atualizado = meta.atualizadoEm?.toDate ? meta.atualizadoEm.toDate().toLocaleDateString('pt-BR') : '';
  const cab = h('div', { class: 'cartao' }, h('h2', { text: meta.titulo }),
    atualizado ? h('p', { class: 'dica', text: `Atualizado em ${atualizado}${meta.atualizadoPor ? ` por ${meta.atualizadoPor}` : ''}` }) : null,
    seletor, botoesAdmin(meta));

  if (r.chave !== `${meta.id}:${meta.versao}`) {
    r.paginas = null;
    if (!r.erro) carregarRoteiro(meta);
    return h('div', {}, cab, r.erro
      ? h('div', { class: 'cartao' }, h('p', { class: 'erro', role: 'alert', text: 'Não consegui abrir o roteiro. Recarregue a página e tente de novo.' }))
      : carregandoLogo('Abrindo o roteiro…'));
  }
  const paginas = r.paginas;
  const total = paginas.length;
  r.pagina = Math.min(Math.max(1, r.pagina), total);
  const ir = (n) => { r.pagina = Math.min(Math.max(1, n), total); renderConteudo(); window.scrollTo(0, 0); };
  const atual = paginas[r.pagina - 1];

  const busca = h('input', {
    type: 'search', value: r.busca, placeholder: 'Buscar no roteiro (ex.: margem, token, prazo)…', 'aria-label': 'Buscar no roteiro',
    oninput: (e) => { r.busca = e.target.value; clearTimeout(estado.tBusca); estado.tBusca = setTimeout(() => { renderConteudo(); const i = document.querySelector('#conteudo input[type=search]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250); },
  });
  const termo = L.semAcento(r.busca).toLowerCase().trim();
  let resultados = null;
  if (termo.length >= 2) {
    resultados = paginas.map((p) => {
      const t = L.semAcento(p.texto).toLowerCase();
      const i = t.indexOf(termo);
      return i < 0 ? null : { n: p.n, trecho: `${i > 40 ? '…' : ''}${p.texto.slice(Math.max(0, i - 40), i + 90).trim()}…` };
    }).filter(Boolean);
  }
  const blocoBusca = h('div', { class: 'cartao' }, busca,
    resultados ? (resultados.length
      ? h('ul', { class: 'res-roteiro' }, resultados.slice(0, 30).map((x) => h('li', {}, h('button', { class: 'link', onclick: () => { r.busca = ''; ir(x.n); }, text: `Página ${x.n}` }), h('span', { text: ` · ${x.trecho}` }))))
      : h('p', { class: 'dica', text: 'Não achei esse termo no roteiro.' })) : null);

  const nav = (extra) => h('div', { class: 'nav-roteiro' + (extra ? ` ${extra}` : '') },
    h('button', { class: 'btn sec', disabled: r.pagina <= 1, onclick: () => ir(r.pagina - 1), text: '← Anterior' }),
    h('select', { 'aria-label': 'Ir para a página', onchange: (e) => ir(Number(e.target.value)) },
      paginas.map((p) => h('option', { value: p.n, text: `Página ${p.n} de ${total}`, selected: p.n === r.pagina }))),
    h('button', { class: 'btn sec', disabled: r.pagina >= total, onclick: () => ir(r.pagina + 1), text: 'Próxima →' }));
  const imagem = h('img', { class: 'slide', src: atual.img, alt: `Roteiro, página ${r.pagina} de ${total}`, title: 'Toque para ampliar',
    onclick: () => { const m = abrirModal(`Página ${r.pagina} de ${total}`, h('img', { class: 'slide', src: atual.img, alt: `Roteiro, página ${r.pagina}` }), { largo: true }); return m; } });
  return h('div', {}, cab, blocoBusca, h('div', { class: 'cartao' }, nav(), imagem, nav('baixo')));
}

document.addEventListener('keydown', (e) => {
  if (estado.aba !== 'roteiro' || !estado.me || !estado.rot.paginas) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) || document.querySelector('.modal')) return;
  const r = estado.rot;
  if (e.key === 'ArrowRight' && r.pagina < r.paginas.length) { r.pagina++; renderConteudo(); } else if (e.key === 'ArrowLeft' && r.pagina > 1) { r.pagina--; renderConteudo(); }
});

async function lerPdfEmPaginas(arquivo, aoAvancar) {
  const pdfjs = await import(new URL('./vendor/pdfjs/pdf.min.js', document.baseURI).href);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.js', document.baseURI).href;
  const doc = await pdfjs.getDocument({ data: await arquivo.arrayBuffer(), isEvalSupported: false }).promise;
  const paginas = [];
  for (let n = 1; n <= doc.numPages; n++) {
    aoAvancar(n, doc.numPages);
    const pg = await doc.getPage(n);
    const v0 = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: Math.min(2, 1280 / v0.width) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    let img = '';
    for (const q of [0.75, 0.6, 0.45]) { img = canvas.toDataURL('image/jpeg', q); if (img.length < 700000) break; }
    if (img.length >= 900000) throw new Error(`A página ${n} ficou pesada demais.`);
    const tc = await pg.getTextContent();
    const texto = L.limparTexto(tc.items.map((i) => i.str).join(' ')).slice(0, 4000);
    paginas.push({ n, img, texto });
    pg.cleanup();
  }
  await doc.destroy();
  return paginas;
}

function abrirPublicarRoteiro(meta) {
  const titulo = h('input', { type: 'text', maxlength: '80', value: meta ? meta.titulo : '', placeholder: 'Ex.: BMG – Consignado Privado Trabalhador' });
  const arquivo = h('input', { type: 'file', accept: '.pdf,application/pdf' });
  const erro = h('div', { class: 'erro', hidden: true, role: 'alert' });
  const andamento = h('p', { class: 'dica', 'aria-live': 'polite' });
  const botao = h('button', { class: 'btn', text: meta ? 'Atualizar roteiro' : 'Publicar roteiro' });
  let m;
  botao.addEventListener('click', async () => {
    erro.hidden = true;
    const t = L.limparTexto(titulo.value);
    const f = arquivo.files[0];
    const id = meta ? meta.id : L.slug(t);
    if (t.length < 3 || !id) { erro.textContent = 'Informe o título do roteiro.'; erro.hidden = false; return; }
    if (!meta && estado.roteiros.some((x) => x.id === id)) { erro.textContent = 'Já existe um roteiro com esse título. Use "Atualizar este roteiro".'; erro.hidden = false; return; }
    if (!f) { erro.textContent = 'Escolha o arquivo PDF.'; erro.hidden = false; return; }
    if (f.size > 40 * 1024 * 1024) { erro.textContent = 'O PDF é grande demais (máximo 40 MB).'; erro.hidden = false; return; }
    botao.disabled = true; arquivo.disabled = true; titulo.disabled = true;
    try {
      const paginas = await lerPdfEmPaginas(f, (n, tot) => { andamento.textContent = `Preparando a página ${n} de ${tot}…`; });
      if (!paginas.length) throw new Error('PDF sem páginas');
      const versao = Date.now();
      let lote = []; let bytes = 0; let feitas = 0;
      const gravar = async () => {
        if (!lote.length) return;
        const b = writeBatch(db);
        lote.forEach((p) => b.set(doc(db, 'roteiro_paginas', `${id}_${versao}_${String(p.n).padStart(3, '0')}`), { roteiroId: id, v: versao, n: p.n, img: p.img, texto: p.texto }));
        await b.commit();
        feitas += lote.length; lote = []; bytes = 0;
        andamento.textContent = `Enviando… ${feitas} de ${paginas.length} páginas`;
      };
      for (const p of paginas) {
        if (bytes + p.img.length > 6000000 || lote.length >= 20) await gravar();
        lote.push(p); bytes += p.img.length;
      }
      await gravar();
      await setDoc(doc(db, 'roteiros', id), { titulo: t, paginas: paginas.length, versao, arquivo: f.name.slice(0, 120), atualizadoEm: serverTimestamp(), atualizadoPor: estado.me.nome });
      // versões antigas saem depois que a nova já está no ar
      try {
        const velhas = await getDocs(query(collection(db, 'roteiro_paginas'), where('roteiroId', '==', id)));
        const apagar = velhas.docs.filter((d) => d.data().v !== versao).map((d) => d.id);
        for (let i = 0; i < apagar.length; i += TAMANHO_LOTE_ESCRITA) {
          const b = writeBatch(db);
          apagar.slice(i, i + TAMANHO_LOTE_ESCRITA).forEach((pid) => b.delete(doc(db, 'roteiro_paginas', pid)));
          await b.commit();
        }
      } catch (e) { console.error('limpeza roteiro', e?.code || e); }
      estado.rot.id = id; estado.rot.paginas = null; estado.rot.chave = ''; estado.rot.erro = false;
      m.fechar();
      aviso('Roteiro publicado. Já aparece para todos.');
    } catch (e) {
      console.error('publicar roteiro', e?.code || e?.message || e);
      erro.textContent = String(e?.code).includes('permission') ? 'Sem permissão para publicar. Confira se as regras novas do Firebase foram publicadas.' : (e?.message?.includes('pesada') ? e.message : 'Não consegui ler ou enviar o PDF. Tente de novo.');
      erro.hidden = false; andamento.textContent = '';
      botao.disabled = false; arquivo.disabled = false; titulo.disabled = !!meta ? true : false;
    }
  });
  if (meta) titulo.disabled = true;
  m = abrirModal(meta ? 'Atualizar roteiro' : 'Novo roteiro', h('div', {},
    campo('Título', titulo, meta ? 'O título continua o mesmo. Só o conteúdo é trocado.' : ''), campo('Arquivo PDF', arquivo, 'Cada página vira uma imagem pesquisável. Pode levar alguns minutos para PDFs grandes.'),
    andamento, erro, h('div', { class: 'acoes' }, botao)));
}

async function excluirRoteiro(meta) {
  if (!(await confirmar('Excluir roteiro', `Apagar "${meta.titulo}" para todos? Não dá para desfazer.`, 'Excluir', true))) return;
  try {
    const s = await getDocs(query(collection(db, 'roteiro_paginas'), where('roteiroId', '==', meta.id)));
    const ids = s.docs.map((d) => d.id);
    for (let i = 0; i < ids.length; i += TAMANHO_LOTE_ESCRITA) {
      const b = writeBatch(db);
      ids.slice(i, i + TAMANHO_LOTE_ESCRITA).forEach((pid) => b.delete(doc(db, 'roteiro_paginas', pid)));
      await b.commit();
    }
    await deleteDoc(doc(db, 'roteiros', meta.id));
    estado.rot.id = null; estado.rot.paginas = null; estado.rot.chave = '';
    aviso('Roteiro excluído.');
  } catch (e) { console.error('excluir roteiro', e?.code || e); aviso('Não consegui excluir.', 'erro'); }
}

// ---------- IMPORTAR (admin) ----------
function viewImportar() {
  const produto = h('select', { required: true }, h('option', { value: '', text: 'Escolha…' }), produtosAtivos().map((p) => h('option', { value: p.id, text: p.nome })));
  const origem = h('input', { type: 'text', maxlength: '60', placeholder: 'Ex.: Base Saque Outubro, Campanha Instagram' });
  const arquivo = h('input', { type: 'file', accept: '.xlsx,.csv,.txt' });
  const saida = h('div', {});
  let preparado = null;

  let ultimaAssinatura = '';
  async function analisar() {
    const arq = arquivo.files[0];
    const org = L.limparTexto(origem.value).slice(0, 60);
    if (!produto.value || org.length < 2 || !arq) { limpar(saida); preparado = null; ultimaAssinatura = ''; return; }
    // evita refazer a leitura (e apagar o botão) quando nada mudou, p.ex. ao sair de um campo
    const assinatura = `${produto.value}|${org}|${arq.name}|${arq.size}|${arq.lastModified}`;
    if (assinatura === ultimaAssinatura) return;
    ultimaAssinatura = assinatura;
    if (!estado.leadsPronto) { limpar(saida); saida.append(carregandoLogo('Aguarde: carregando os leads existentes…')); ultimaAssinatura = ''; return; }
    const novoConteudo = [];
    let novoPreparado = null;
    try {
      const linhas = await lerArquivoTabela(arq);
      if (assinatura !== ultimaAssinatura) return; // outra análise começou depois desta
      const existentes = new Set(leadsLista().map((l) => l.id));
      // quando cada CPF entrou por último, por produto (sem data confiável = conta como "agora")
      const ultimaEntrada = new Map();
      for (const l of leadsLista()) {
        if (!l.produtoId || !l.cpf) continue;
        const ms = typeof l.criadoEm?.toMillis === 'function' ? l.criadoEm.toMillis() : Date.now();
        const k = L.idLead(l.produtoId, l.cpf);
        if (!(ultimaEntrada.get(k) >= ms)) ultimaEntrada.set(k, ms);
      }
      const loteId = `l${Date.now().toString(36)}`;
      const r = L.prepararLeads(linhas, { produtoId: produto.value, loteId, origem: org, existentes, ultimaEntrada });
      novoPreparado = { ...r, loteId, origem: org, produtoId: produto.value };
      const rs = r.resumo;
      novoConteudo.push(
        h('div', { class: 'cartao' },
          h('h3', { text: `${rs.validas} leads prontos para importar` }),
          h('p', { class: 'dica', text: `Colunas usadas: nome = "${r.colunas.nome}", CPF = "${r.colunas.cpf}", telefone = ${r.colunas.tel ? `"${r.colunas.tel}"` : 'não encontrado'}; ${r.colunas.extras} coluna(s) extra(s) guardadas na ficha.` }),
          h('ul', {},
            rs.cpfInvalido ? h('li', { text: `${rs.cpfInvalido} com CPF inválido (ignorados)` }) : null,
            rs.semNome ? h('li', { text: `${rs.semNome} sem nome (ignorados)` }) : null,
            rs.duplicadasNoArquivo ? h('li', { text: `${rs.duplicadasNoArquivo} CPF repetido no arquivo (ignorados)` }) : null,
            rs.ofertasUnidas ? h('li', { text: `${rs.ofertasUnidas} linha(s) com CPF repetido: as ofertas foram unidas no mesmo lead` }) : null,
            rs.jaExistem ? h('li', { text: `${rs.jaExistem} já entraram nesse produto há menos de ${L.DIAS_BLOQUEIO} dias (ignorados)` }) : null,
            rs.reentradas ? h('li', { text: `${rs.reentradas} já estavam na base há mais de ${L.DIAS_BLOQUEIO} dias e entram de novo como lead novo` }) : null),
          r.ignorados.length ? h('details', {}, h('summary', { text: 'Ver linhas ignoradas' }), h('ul', {}, r.ignorados.slice(0, 50).map((i) => h('li', { text: `Linha ${i.linha}: ${i.motivo}` })), r.ignorados.length > 50 ? h('li', { text: `… e mais ${r.ignorados.length - 50}` }) : null)) : null,
          h('div', { style: 'display:flex;justify-content:flex-end;margin-top:12px' },
            h('button', { class: 'btn', disabled: !rs.validas, text: `Importar ${rs.validas} leads`, onclick: (e) => importar(e.target) }))));
    } catch (err) {
      novoConteudo.push(h('div', { class: 'erro', role: 'alert', text: err.message || 'Não consegui ler o arquivo.' }));
      ultimaAssinatura = '';
    }
    preparado = novoPreparado;
    limpar(saida);
    saida.append(...novoConteudo);
  }

  async function importar(botao) {
    if (!preparado) return;
    botao.disabled = true;
    const p = preparado;
    try {
      const nomeLote = `${nomeProduto(p.produtoId)} · ${p.origem} · ${agoraBr()}`;
      const ops = [[doc(db, 'lotes', p.loteId), { nome: nomeLote, produtoId: p.produtoId, origem: p.origem, total: p.leads.length, criadoEm: serverTimestamp(), criadoPor: estado.me.nome }, 'set']];
      p.leads.forEach((l) => ops.push([doc(db, 'leads', l.id), {
        nome: l.nome, cpf: l.cpf, telefone: l.telefone, produtoId: l.produtoId, loteId: l.loteId, origem: l.origem, extras: l.extras, ord: l.ord,
        lojaId: null, consultorId: null, status: 'novo', motivo: '', obs: '', vendaEm: '', indicacoes: [], indicacao: false, indicadoPor: '', indicadoDe: '',
        criadoEm: serverTimestamp(), hist: [],
      }, 'set']));
      await gravarEmLotes(ops);
      aviso(`${p.leads.length} leads importados.`);
      estado.importarEmUso = false;
      estado.aba = 'distribuir';
      telaApp();
    } catch (e) {
      console.error('importar', e?.code || e);
      aviso(String(e?.code).includes('permission-denied')
        ? 'Alguns CPFs acabaram de ser importados por outra pessoa. Recarregue a página e importe de novo: o que já entrou é ignorado.'
        : 'A importação falhou no meio. Importe o mesmo arquivo de novo: o que já entrou é ignorado.', 'erro');
      botao.disabled = false;
    }
  }

  async function excluirLote(lote) {
    const ligados = leadsLista().filter((l) => l.loteId === lote.id);
    const ids = new Set(ligados.map((l) => l.id));
    const indic = leadsLista().filter((l) => l.indicacao && ids.has(l.indicadoDe));
    const total = ligados.length + indic.length;
    const texto = `Excluir o lote "${lote.nome}"? Serão apagados ${ligados.length} leads e ${indic.length} indicações geradas por eles. Isso não pode ser desfeito.`;
    if (!(await confirmarDigitando('Excluir lote', texto, 'EXCLUIR'))) return;
    try {
      const refs = [...ligados, ...indic].map((l) => doc(db, 'leads', l.id));
      for (let i = 0; i < refs.length; i += TAMANHO_LOTE_ESCRITA) {
        const b = writeBatch(db);
        refs.slice(i, i + TAMANHO_LOTE_ESCRITA).forEach((r) => b.delete(r));
        await b.commit();
      }
      await deleteDoc(doc(db, 'lotes', lote.id));
      aviso(`Lote excluído (${total} leads apagados).`);
    } catch (e) {
      console.error('excluir lote', e?.code || e);
      aviso('A exclusão falhou no meio. Tente de novo: o que já foi apagado continua apagado.', 'erro');
    }
  }

  const contagemLote = new Map();
  leadsLista().forEach((l) => contagemLote.set(l.loteId, (contagemLote.get(l.loteId) || 0) + 1));
  const listaLotes = estado.lotes.length ? h('div', { class: 'cartao' }, h('h3', { text: 'Lotes importados' }),
    h('div', { class: 'tabela-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'Lote' }), h('th', { class: 'num', text: 'Leads' }), h('th', {}))),
      h('tbody', {}, estado.lotes.map((lt) => h('tr', {},
        h('td', { text: lt.nome }),
        h('td', { class: 'num', text: String(contagemLote.get(lt.id) || 0) }),
        h('td', { class: 'num' }, h('button', { class: 'btn sec peq', text: 'Excluir', onclick: () => excluirLote(lt) })))))))) : null;

  estado.importarEmUso = false;
  [produto, origem, arquivo].forEach((el) => el.addEventListener('change', () => { estado.importarEmUso = true; analisar(); }));
  return h('div', {}, h('div', { class: 'cartao' }, h('h2', { text: 'Importar leads' }),
    h('p', { class: 'dica', text: 'A planilha precisa ter as colunas NOME e CPF. Telefone é opcional; as outras colunas ficam guardadas na ficha do lead.' }),
    h('div', { class: 'linha' }, campo('Produto', produto), campo('De onde vieram esses leads?', origem, 'Obrigatório. Aparece em cada lead.'), campo('Arquivo (.xlsx ou .csv)', arquivo))), saida, listaLotes);
}

// ---------- EQUIPE ----------
async function criarConta({ nome, role, lojaId, usuario, senha, resetDe }) {
  const email = `${usuario}.${hex(4)}@${DOMINIO_INTERNO}`;
  const cred = await createUserWithEmailAndPassword(authSec, email, senha);
  const uid = cred.user.uid;
  try { await signOut(authSec); } catch { /* sessão secundária só serve para criar a conta */ }
  const b = writeBatch(db);
  const novo = { id: usuario, nome, usuario, role, lojaId: lojaId || null, ativo: true, mustChange: true, criadoEm: serverTimestamp() };
  if (resetDe) novo.resetOf = resetDe;
  b.set(doc(db, 'usuarios', uid), novo);
  if (resetDe) b.delete(doc(db, 'usuarios', resetDe));
  b.set(doc(db, 'logins', usuario), { email, uid });
  await b.commit();
}

async function redefinirSenha(alvo) {
  if (!(await confirmar('Redefinir senha', `Gerar uma senha provisória para ${alvo.nome}? A senha atual deixa de valer.`, 'Redefinir'))) return;
  const senha = L.gerarSenhaTemporaria(bytesAleatorios);
  try {
    await criarConta({ nome: alvo.nome, role: alvo.role, lojaId: alvo.lojaId, usuario: alvo.usuario, senha, resetDe: alvo._uid });
    mostrarSenha('Senha redefinida', [{ nome: alvo.nome, usuario: alvo.usuario, senha }]);
  } catch (e) {
    console.error('reset', e?.code || e);
    aviso('Não consegui redefinir a senha. Tente de novo.', 'erro');
  }
}

function viewEquipe() {
  const me = estado.me;
  const lista = estado.usuarios.filter((u) => u.id !== me.id);
  const cab = ehAdmin() ? h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px' },
    h('button', { class: 'btn', onclick: abrirNovoUsuario, text: 'Novo usuário' }),
    h('button', { class: 'btn sec', onclick: abrirImportarEstrutura, text: 'Carregar estrutura (planilha)' })) : null;
  const linhas = lista.map((u) => h('tr', {},
    h('td', { text: u.nome }), h('td', { text: u.usuario }), h('td', { text: L.PAPEIS[u.role] }),
    h('td', { text: u.lojaId ? nomeLoja(u.lojaId) : '—' }),
    h('td', {}, h('span', { class: `tag ${u.ativo ? 'venda' : 'perdido'}`, text: u.ativo ? 'Ativo' : 'Inativo' }), u.mustChange ? [' ', h('span', { class: 'tag alerta', text: 'Não entrou ainda' })] : null),
    h('td', {}, L.podeGerenciar({ ...me, ativo: true }, u) ? h('button', { class: 'btn sec peq', onclick: () => redefinirSenha(u), text: 'Redefinir senha' }) : null,
      ehAdmin() ? [' ', h('button', { class: 'btn sec peq', onclick: () => abrirEditarUsuario(u), text: 'Editar' }), ' ', h('button', { class: 'btn sec peq', onclick: () => alternarAtivo(u), text: u.ativo ? 'Desativar' : 'Ativar' })] : null)));
  return h('div', {}, h('div', { class: 'cartao' }, h('h2', { text: 'Equipe' }), cab,
    linhas.length ? h('div', { class: 'tabela-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Nome', 'Usuário', 'Cargo', 'Loja', 'Situação', ''].map((t) => h('th', { text: t })))), h('tbody', {}, linhas))) : h('p', { class: 'vazio', text: 'Ninguém cadastrado ainda.' })));
}

async function alternarAtivo(u) {
  const novo = !u.ativo;
  if (!(await confirmar(novo ? 'Ativar usuário' : 'Desativar usuário', `${novo ? 'Liberar' : 'Bloquear'} o acesso de ${u.nome}?`, novo ? 'Ativar' : 'Desativar', !novo))) return;
  try { await updateDoc(doc(db, 'usuarios', u._uid), { ativo: novo }); aviso(novo ? 'Usuário ativado.' : 'Usuário desativado.'); } catch (e) { console.error('ativo', e?.code || e); aviso('Não consegui alterar.', 'erro'); }
}

function abrirEditarUsuario(u) {
  const nome = h('input', { type: 'text', required: true, maxlength: '80', value: u.nome });
  const role = h('select', {}, ['consultor', 'supervisor', 'diretor'].map((r) => h('option', { value: r, text: L.PAPEIS[r], selected: u.role === r })));
  const loja = h('select', {}, lojasAtivas().map((l) => h('option', { value: l.id, text: l.nome, selected: u.lojaId === l.id })));
  const erro = h('div', { class: 'erro', hidden: true, role: 'alert' });
  const blocoLoja = h('div', {}, campo('Loja', loja));
  blocoLoja.hidden = role.value === 'diretor';
  role.addEventListener('change', () => { blocoLoja.hidden = role.value === 'diretor'; });
  const botao = h('button', { class: 'btn', text: 'Salvar' });
  let m;
  botao.addEventListener('click', async () => {
    erro.hidden = true;
    const n = L.tituloNome(nome.value);
    if (n.length < 2) { erro.textContent = 'Informe o nome.'; erro.hidden = false; return; }
    const novoRole = role.value;
    const novaLoja = novoRole === 'diretor' ? null : loja.value;
    if (novoRole !== 'diretor' && !novaLoja) { erro.textContent = 'Escolha a loja.'; erro.hidden = false; return; }
    const mudancas = {};
    if (n !== u.nome) mudancas.nome = n;
    if (novoRole !== u.role) mudancas.role = novoRole;
    if ((novaLoja || null) !== (u.lojaId || null)) mudancas.lojaId = novaLoja;
    if (!Object.keys(mudancas).length) { m.fechar(); return; }
    const outroSup = estado.usuarios.find((x) => x.role === 'supervisor' && x.lojaId === novaLoja && x.ativo && x._uid !== u._uid);
    if (novoRole === 'supervisor' && outroSup && !(await confirmar('Loja já tem supervisor', `${nomeLoja(novaLoja)} já tem ${outroSup.nome}. Salvar mesmo assim?`, 'Salvar'))) return;
    // consultor que muda de loja leva os leads dele junto (senão ficariam presos na loja antiga)
    const meusLeads = u.role === 'consultor' && 'lojaId' in mudancas && novoRole === 'consultor' ? leadsLista().filter((l) => l.consultorId === u.id) : [];
    if (('role' in mudancas) && u.role === 'consultor' && leadsLista().some((l) => l.consultorId === u.id)) {
      if (!(await confirmar('Mudar de cargo', `${u.nome} tem leads no nome dele. Eles continuam com ele depois da mudança. Salvar?`, 'Salvar'))) return;
    }
    if (meusLeads.length && !(await confirmar('Mudar de loja', `Os ${meusLeads.length} leads de ${u.nome} vão junto para ${nomeLoja(novaLoja)}. Salvar?`, 'Salvar'))) return;
    botao.disabled = true;
    try {
      await gravarEmLotes([[doc(db, 'usuarios', u._uid), mudancas, 'update'], ...meusLeads.map((l) => [doc(db, 'leads', l.id), { lojaId: novaLoja }, 'update'])]);
      m.fechar();
      aviso('Usuário atualizado.');
    } catch (e) {
      console.error('editar usuário', e?.code || e);
      erro.textContent = 'Não consegui salvar. Tente de novo.';
      erro.hidden = false;
      botao.disabled = false;
    }
  });
  m = abrirModal('Editar usuário', h('div', {},
    campo('Nome completo', nome), campo('Cargo', role), blocoLoja,
    campo('Usuário (para entrar)', h('input', { type: 'text', value: u.usuario, disabled: true }), 'O usuário não muda, porque os leads ficam ligados a ele. Para trocar, cadastre uma pessoa nova.'),
    erro, h('div', { class: 'acoes' }, botao)));
}

function abrirNovoUsuario() {
  const nome = h('input', { type: 'text', required: true, maxlength: '80' });
  const role = h('select', {}, ['consultor', 'supervisor', 'diretor'].map((r) => h('option', { value: r, text: L.PAPEIS[r] })));
  const loja = h('select', {}, lojasAtivas().map((l) => h('option', { value: l.id, text: l.nome })));
  const usuario = h('input', { type: 'text', maxlength: '40', autocapitalize: 'none' });
  const erro = h('div', { class: 'erro', hidden: true, role: 'alert' });
  const blocoLoja = h('div', {}, campo('Loja', loja));
  role.addEventListener('change', () => { blocoLoja.hidden = role.value === 'diretor'; });
  nome.addEventListener('input', () => { if (!usuario.dataset.manual) usuario.value = L.gerarUsuario(nome.value, new Set(estado.usuarios.map((u) => u.usuario))); });
  usuario.addEventListener('input', () => { usuario.dataset.manual = '1'; });
  const botao = h('button', { class: 'btn', text: 'Cadastrar' });
  let m;
  botao.addEventListener('click', async () => {
    erro.hidden = true;
    const u = usuario.value.trim().toLowerCase();
    const n = L.tituloNome(nome.value);
    if (n.length < 2 || !/^[a-z0-9._-]{2,40}$/.test(u)) { erro.textContent = 'Informe o nome e um usuário válido (letras minúsculas, números, ponto ou traço).'; erro.hidden = false; return; }
    if (estado.usuarios.some((x) => x.usuario === u)) { erro.textContent = 'Já existe alguém com esse usuário.'; erro.hidden = false; return; }
    if (role.value === 'supervisor' && supervisorDaLoja(loja.value) && !(await confirmar('Loja já tem supervisor', `${nomeLoja(loja.value)} já tem ${supervisorDaLoja(loja.value).nome}. Cadastrar outro mesmo assim?`, 'Cadastrar'))) return;
    botao.disabled = true;
    const senha = L.gerarSenhaTemporaria(bytesAleatorios);
    try {
      await criarConta({ nome: n, role: role.value, lojaId: role.value === 'diretor' ? null : loja.value, usuario: u, senha });
      m.fechar();
      mostrarSenha('Usuário cadastrado', [{ nome: n, usuario: u, senha }]);
    } catch (e) {
      console.error('novo usuário', e?.code || e);
      erro.textContent = 'Não consegui cadastrar. Tente de novo.';
      erro.hidden = false;
      botao.disabled = false;
    }
  });
  m = abrirModal('Novo usuário', h('div', {}, campo('Nome completo', nome), campo('Cargo', role), blocoLoja, campo('Usuário (para entrar)', usuario, 'Sugerido pelo nome. Pode mudar.'), erro, h('div', { class: 'acoes' }, botao)));
}

function abrirImportarEstrutura() {
  const arquivo = h('input', { type: 'file', accept: '.xlsx,.csv' });
  const saida = h('div', {});
  let plano = null;
  let m;
  arquivo.addEventListener('change', async () => {
    limpar(saida); plano = null;
    try {
      const linhas = await lerArquivoTabela(arquivo.files[0]);
      const { pessoas, avisos } = L.lerFuncionarios(linhas);
      const usados = new Set(estado.usuarios.map((u) => u.usuario));
      const existentes = new Set(estado.usuarios.map((u) => `${L.slug(u.nome)}|${u.lojaId}`));
      const itens = [];
      for (const p of pessoas) {
        const ja = existentes.has(`${L.slug(p.nome)}|${p.lojaId}`);
        const usuario = ja ? '' : L.gerarUsuario(p.nome, usados);
        if (!ja) usados.add(usuario);
        itens.push({ ...p, usuario, ja });
      }
      plano = itens.filter((i) => !i.ja);
      saida.append(
        avisos.length ? h('div', { class: 'erro', text: avisos.join(' ') }) : null,
        h('p', { text: `${plano.length} pessoa(s) para cadastrar; ${itens.length - plano.length} já cadastrada(s).` }),
        h('div', { class: 'tabela-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Nome', 'Cargo', 'Loja', 'Usuário'].map((t) => h('th', { text: t })))),
          h('tbody', {}, itens.map((i) => h('tr', {}, h('td', { text: i.nome }), h('td', { text: L.PAPEIS[i.papel] }), h('td', { text: i.lojaNome }), h('td', { text: i.ja ? 'já cadastrada' : i.usuario })))))),
        h('div', { class: 'acoes' }, h('button', { class: 'btn', disabled: !plano.length, text: 'Cadastrar todos', onclick: (e) => executar(e.target) })));
    } catch (e) { saida.append(h('div', { class: 'erro', role: 'alert', text: e.message })); }
  });

  async function executar(botao) {
    botao.disabled = true;
    const entregues = [];
    const falhas = [];
    try {
      const lojas = new Map(plano.map((p) => [p.lojaId, p.lojaNome]));
      const novas = [...lojas].filter(([id]) => !estado.lojas.some((l) => l.id === id));
      if (novas.length) {
        const b = writeBatch(db);
        novas.forEach(([id, nome]) => b.set(doc(db, 'lojas', id), { nome, ativo: true }));
        await b.commit();
      }
      for (const p of plano) {
        botao.textContent = `Cadastrando ${entregues.length + falhas.length + 1} de ${plano.length}…`;
        const senha = L.gerarSenhaTemporaria(bytesAleatorios);
        try {
          await criarConta({ nome: p.nome, role: p.papel, lojaId: p.lojaId, usuario: p.usuario, senha });
          entregues.push({ nome: p.nome, usuario: p.usuario, senha });
        } catch (e) { console.error('estrutura', p.usuario, e?.code || e); falhas.push(p.nome); }
      }
    } catch (e) { console.error('estrutura', e?.code || e); aviso('Não consegui criar as lojas.', 'erro'); }
    m.fechar();
    if (entregues.length) mostrarSenha('Acessos criados', entregues);
    if (falhas.length) aviso(`Não cadastrei: ${falhas.join(', ')}. Rode de novo para tentar só esses.`, 'erro');
  }
  m = abrirModal('Carregar estrutura (planilha)', h('div', {}, h('p', { class: 'dica', text: 'Planilha com as colunas Nomes, Loja e Cargo (supervisor ou consultor).' }), campo('Arquivo', arquivo), saida), { largo: true });
}

// ---------- CADASTROS (admin) ----------
function viewCadastros() {
  const nomeProd = h('input', { type: 'text', maxlength: '40', placeholder: 'Ex.: Cartão consignado' });
  const nomeLojaNova = h('input', { type: 'text', maxlength: '60', placeholder: 'Ex.: Help Centro' });
  const addProd = async () => {
    const n = L.limparTexto(nomeProd.value);
    const id = L.slug(n);
    if (n.length < 2 || !id) return aviso('Informe o nome do produto.', 'erro');
    if (estado.produtos.some((p) => p.id === id)) return aviso('Esse produto já existe.', 'erro');
    try { await setDoc(doc(db, 'produtos', id), { nome: n, ativo: true, ordem: estado.produtos.length }); nomeProd.value = ''; aviso('Produto cadastrado.'); } catch (e) { console.error('produto', e?.code || e); aviso('Não consegui cadastrar.', 'erro'); }
    return undefined;
  };
  const addLoja = async () => {
    const n = L.limparTexto(nomeLojaNova.value);
    const id = L.slug(n);
    if (n.length < 2 || !id) return aviso('Informe o nome da loja.', 'erro');
    if (estado.lojas.some((l) => l.id === id)) return aviso('Essa loja já existe.', 'erro');
    try { await setDoc(doc(db, 'lojas', id), { nome: n, ativo: true }); nomeLojaNova.value = ''; aviso('Loja cadastrada.'); } catch (e) { console.error('loja', e?.code || e); aviso('Não consegui cadastrar.', 'erro'); }
    return undefined;
  };
  const alternar = async (colecao, item) => {
    try { await updateDoc(doc(db, colecao, item.id), { ativo: item.ativo === false }); } catch (e) { console.error('alternar', e?.code || e); aviso('Não consegui alterar.', 'erro'); }
  };
  const editar = (colecao, item, rotulo) => {
    const nome = h('input', { type: 'text', maxlength: colecao === 'produtos' ? '40' : '60', value: item.nome });
    const erro = h('div', { class: 'erro', hidden: true, role: 'alert' });
    const salvar = h('button', { class: 'btn', text: 'Salvar' });
    let m;
    salvar.addEventListener('click', async () => {
      erro.hidden = true;
      const n = L.limparTexto(nome.value);
      const outros = colecao === 'produtos' ? estado.produtos : estado.lojas;
      if (n.length < 2) { erro.textContent = `Informe o nome ${rotulo === 'produto' ? 'do produto' : 'da loja'}.`; erro.hidden = false; return; }
      if (outros.some((o) => o.id !== item.id && L.slug(o.nome) === L.slug(n))) { erro.textContent = `Já existe ${rotulo === 'produto' ? 'um produto' : 'uma loja'} com esse nome.`; erro.hidden = false; return; }
      if (n === item.nome) { m.fechar(); return; }
      salvar.disabled = true;
      try { await updateDoc(doc(db, colecao, item.id), { nome: n }); m.fechar(); aviso('Nome atualizado.'); } catch (e) {
        console.error('editar', e?.code || e); erro.textContent = 'Não consegui salvar. Tente de novo.'; erro.hidden = false; salvar.disabled = false;
      }
    });
    m = abrirModal(`Editar ${rotulo}`, h('div', {}, campo('Nome', nome, 'Só muda o nome que aparece na tela. Os leads e o histórico continuam ligados.'), erro, h('div', { class: 'acoes' }, salvar)));
  };
  const lista = (colecao, itens, rotulo) => h('ul', { style: 'list-style:none;padding:0;margin:12px 0 0' }, itens.map((i) => h('li', { style: 'display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--linha)' },
    h('span', { style: 'flex:1', text: i.nome }), h('span', { class: `tag ${i.ativo === false ? 'perdido' : 'venda'}`, text: i.ativo === false ? 'Inativo' : 'Ativo' }),
    h('button', { class: 'btn sec peq', onclick: () => editar(colecao, i, rotulo), text: 'Editar' }),
    h('button', { class: 'btn sec peq', onclick: () => alternar(colecao, i), text: i.ativo === false ? 'Ativar' : 'Desativar' }))));
  return h('div', {},
    h('div', { class: 'cartao' }, h('h2', { text: 'Produtos' }), h('div', { class: 'linha' }, nomeProd, h('div', { class: 'fixo' }, h('button', { class: 'btn', onclick: addProd, text: 'Adicionar' }))), lista('produtos', estado.produtos, 'produto')),
    h('div', { class: 'cartao' }, h('h2', { text: 'Lojas' }), h('div', { class: 'linha' }, nomeLojaNova, h('div', { class: 'fixo' }, h('button', { class: 'btn', onclick: addLoja, text: 'Adicionar' }))), lista('lojas', estado.lojas, 'loja')));
}

iniciar();
