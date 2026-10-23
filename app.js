// app.js — Painel de Leads da Rede Confia (lojas Help).
// Tela + conversa com o Firebase. As regras de negócio ficam em logic.js.
// IMPORTANTE: quem protege os dados é o arquivo firestore.rules; esta tela só esconde o que a pessoa não pode usar.

import { firebaseConfig } from './firebase-config.js';
import * as L from './logic.js';
import { lerXlsx } from './xlsx.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeAuth, browserSessionPersistence, inMemoryPersistence, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, onAuthStateChanged, updatePassword,
  reauthenticateWithCredential, EmailAuthProvider,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, collection, getDoc, setDoc, updateDoc, writeBatch, onSnapshot, query, where, serverTimestamp,
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
  raiz.append(h('div', { class: 'centro' }, h('div', { class: 'logo' }, h('img', { src: 'logo.png', alt: 'Help – Loja de Crédito' })), h('div', { class: 'cartao' }, form)));
  usuario.focus();
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
  raiz.append(h('div', { class: 'centro' }, h('div', { class: 'logo' }, h('img', { src: 'logo.png', alt: 'Help – Loja de Crédito' })),
    h('div', { class: 'cartao' }, h('h2', { text: 'Primeiro acesso' }), h('p', { class: 'dica', text: 'Crie agora o administrador do painel. Esta tela só aparece uma vez.' }), form)));
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
  estado.desinscrever.forEach((f) => f());
  estado.desinscrever = [];
  estado.leadsMap = new Map();
  estado.leadsCache = null;
  estado.leadsPronto = false;
  estado.produtos = []; estado.lojas = []; estado.usuarios = []; estado.lotes = [];
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
function ouvir(consulta, aoReceber) {
  const cancelar = onSnapshot(consulta, aoReceber, (err) => {
    console.error('leitura', err?.code || err);
    aviso('Sem permissão ou sem conexão para carregar alguns dados.', 'erro');
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
    agendarRender();
  });
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
  leads: 'Leads', distribuir: 'Distribuir', relatorio: 'Relatório', importar: 'Importar', equipe: 'Equipe', cadastros: 'Cadastros',
};
function abasDoPerfil() {
  if (ehAdmin()) return ['leads', 'distribuir', 'relatorio', 'importar', 'equipe', 'cadastros'];
  if (ehDiretor()) return ['distribuir', 'relatorio', 'leads', 'equipe'];
  if (ehSupervisor()) return ['leads', 'distribuir', 'relatorio', 'equipe'];
  return ['leads'];
}

function textoQuem() {
  const me = estado.me;
  return ` · ${L.PAPEIS[me.role]}${me.lojaId ? ` · ${nomeLoja(me.lojaId)}` : ''}`;
}

function telaApp() {
  limpar(raiz);
  const abas = abasDoPerfil();
  if (!abas.includes(estado.aba)) estado.aba = abas[0];
  raiz.append(h('div', { class: 'topo' }, h('img', { src: 'logo.png', alt: 'Help – Loja de Crédito' }),
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
  const views = { leads: viewLeads, distribuir: viewDistribuir, relatorio: viewRelatorio, importar: viewImportar, equipe: viewEquipe, cadastros: viewCadastros };
  c.append(views[estado.aba]());
  window.scrollTo(0, y);
}

// ---------- LEADS ----------
function ordemStatus(s) { return { novo: 0, atendimento: 1, proposta: 2, perdido: 3, venda: 4 }[s] ?? 9; }

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
    .sort((a, b) => ordemStatus(a.status) - ordemStatus(b.status) || (a.loteId < b.loteId ? 1 : a.loteId > b.loteId ? -1 : 0) || (a.ord ?? 0) - (b.ord ?? 0));
  const distribuidos = base.filter((l) => !l.indicacao && l.lojaId);
  const vendasDist = distribuidos.filter((l) => l.status === 'venda').length;

  const cards = h('div', { class: 'cards' },
    L.STATUS.map((s) => h('button', {
      class: 'card', 'aria-pressed': String(f.status === s.id),
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
      h('td', {}, h('span', { class: `tag ${l.status}`, text: rotuloStatus(l.status) })))))))
    : h('p', { class: 'vazio', text: estado.leadsPronto ? 'Nenhum lead por aqui.' : 'Carregando leads…' });

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
    if (lead.status) corpo.append(h('p', {}, 'Situação: ', h('span', { class: `tag ${lead.status}`, text: rotuloStatus(lead.status) })));
    if (lead.obs) corpo.append(h('p', { text: `Observação: ${lead.obs}` }));
    if (lead.motivo) corpo.append(h('p', { text: `Motivo: ${lead.motivo}` }));
    if (histLista.length) corpo.append(blocoHistorico(histLista));
    m = abrirModal(lead.nome, corpo);
    return;
  }

  const sel = { status: lead.status };
  const botoesStatus = L.STATUS.map((s) => h('button', {
    type: 'button', 'aria-pressed': String(sel.status === s.id), 'data-status': s.id,
    onclick: () => { sel.status = s.id; botoesStatus.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === s.id))); atualizarCampos(); },
    text: s.nome,
  }));
  const obs = h('textarea', { maxlength: '500', value: lead.obs || '' });
  const motivo = h('input', { type: 'text', maxlength: '120', value: lead.motivo || '' });
  const dataVenda = h('input', { type: 'date', value: lead.vendaEm || hoje() });
  const blocoMotivo = h('div', {}, campo('Motivo (obrigatório)', motivo));
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
    blocoVenda.hidden = sel.status !== 'venda';
  }
  atualizarCampos();

  const botaoSalvar = h('button', { class: 'btn', text: 'Salvar' });
  botaoSalvar.addEventListener('click', async () => {
    erroGeral.hidden = true;
    itensInd.forEach((it) => { it.erro.hidden = true; });
    const upd = { status: sel.status, obs: L.limparTexto(obs.value).slice(0, 500), motivo: '', vendaEm: '', atualizadoEm: serverTimestamp() };
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
      const b = writeBatch(db);
      b.update(doc(db, 'leads', lead.id), upd);
      (indicacoesNovas || []).forEach((it, i) => {
        b.set(doc(db, 'leads', L.idIndicacao(lead.id, i + 1)), {
          nome: it.nome, cpf: it.cpf, telefone: it.telefone, produtoId: lead.produtoId, loteId: 'indicacoes',
          origem: `Indicação de ${lead.nome}`, extras: {}, ord: i, lojaId: lead.lojaId || null, consultorId: lead.consultorId || null,
          status: 'novo', motivo: '', obs: '', vendaEm: '', indicacoes: [], indicacao: true, indicadoPor: lead.nome, indicadoDe: lead.id,
          criadoEm: serverTimestamp(), hist: [],
        });
      });
      await b.commit();
      m.fechar();
      aviso(indicacoesNovas ? 'Venda registrada. As 3 indicações viraram novos leads.' : 'Lead atualizado.');
    } catch (e) {
      console.error('salvar lead', e?.code || e);
      erroGeral.textContent = 'Não consegui salvar. Confira a conexão e tente de novo.';
      erroGeral.hidden = false;
      botaoSalvar.disabled = false;
    }
  });

  corpo.append(
    h('label', { text: 'Situação' }), h('div', { class: 'status-opcoes' }, botoesStatus),
    blocoMotivo, blocoVenda, campo('Observação', obs), erroGeral);

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
    controles.length ? h('div', { class: 'linha' }, controles) : null);

  if (!estado.leadsPronto) return h('div', {}, topo, h('p', { class: 'carregando', text: 'Carregando…' }));
  if (!colunas.length) return h('div', {}, topo, h('div', { class: 'cartao' }, h('p', { class: 'vazio', text: modo === 'lojas' ? 'Nenhum lead esperando distribuição.' : 'Nenhum lead da loja esperando por consultor.' })));
  if (!alvos.length) return h('div', {}, topo, h('div', { class: 'cartao' }, h('p', { class: 'vazio', text: 'Não há destinatários ativos cadastrados.' })));

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
  return h('div', {}, topo, h('div', { class: 'cartao' }, tabela,
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
      h('option', { value: '', text: 'Todos os lotes' }), estado.lotes.map((l) => h('option', { value: l.id, text: l.nome, selected: r.lote === l.id })))) : null));

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
    if (!estado.leadsPronto) { limpar(saida); saida.append(h('p', { class: 'dica', text: 'Aguarde: ainda carregando os leads existentes…' })); ultimaAssinatura = ''; return; }
    const novoConteudo = [];
    let novoPreparado = null;
    try {
      const linhas = await lerArquivoTabela(arq);
      if (assinatura !== ultimaAssinatura) return; // outra análise começou depois desta
      const existentes = new Set(leadsLista().map((l) => l.id));
      const loteId = `l${Date.now().toString(36)}`;
      const r = L.prepararLeads(linhas, { produtoId: produto.value, loteId, origem: org, existentes });
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
            rs.jaExistem ? h('li', { text: `${rs.jaExistem} já existem nesse produto (ignorados)` }) : null),
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
      aviso('A importação falhou no meio. Importe o mesmo arquivo de novo: o que já entrou é ignorado.', 'erro');
      botao.disabled = false;
    }
  }

  estado.importarEmUso = false;
  [produto, origem, arquivo].forEach((el) => el.addEventListener('change', () => { estado.importarEmUso = true; analisar(); }));
  return h('div', {}, h('div', { class: 'cartao' }, h('h2', { text: 'Importar leads' }),
    h('p', { class: 'dica', text: 'A planilha precisa ter as colunas NOME e CPF. Telefone é opcional; as outras colunas ficam guardadas na ficha do lead.' }),
    h('div', { class: 'linha' }, campo('Produto', produto), campo('De onde vieram esses leads?', origem, 'Obrigatório. Aparece em cada lead.'), campo('Arquivo (.xlsx ou .csv)', arquivo))), saida);
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
      ehAdmin() ? [' ', h('button', { class: 'btn sec peq', onclick: () => alternarAtivo(u), text: u.ativo ? 'Desativar' : 'Ativar' })] : null)));
  return h('div', {}, h('div', { class: 'cartao' }, h('h2', { text: 'Equipe' }), cab,
    linhas.length ? h('div', { class: 'tabela-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Nome', 'Usuário', 'Cargo', 'Loja', 'Situação', ''].map((t) => h('th', { text: t })))), h('tbody', {}, linhas))) : h('p', { class: 'vazio', text: 'Ninguém cadastrado ainda.' })));
}

async function alternarAtivo(u) {
  const novo = !u.ativo;
  if (!(await confirmar(novo ? 'Ativar usuário' : 'Desativar usuário', `${novo ? 'Liberar' : 'Bloquear'} o acesso de ${u.nome}?`, novo ? 'Ativar' : 'Desativar', !novo))) return;
  try { await updateDoc(doc(db, 'usuarios', u._uid), { ativo: novo }); aviso(novo ? 'Usuário ativado.' : 'Usuário desativado.'); } catch (e) { console.error('ativo', e?.code || e); aviso('Não consegui alterar.', 'erro'); }
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
  const lista = (colecao, itens) => h('ul', { style: 'list-style:none;padding:0;margin:12px 0 0' }, itens.map((i) => h('li', { style: 'display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--linha)' },
    h('span', { style: 'flex:1', text: i.nome }), h('span', { class: `tag ${i.ativo === false ? 'perdido' : 'venda'}`, text: i.ativo === false ? 'Inativo' : 'Ativo' }),
    h('button', { class: 'btn sec peq', onclick: () => alternar(colecao, i), text: i.ativo === false ? 'Ativar' : 'Desativar' }))));
  return h('div', {},
    h('div', { class: 'cartao' }, h('h2', { text: 'Produtos' }), h('div', { class: 'linha' }, nomeProd, h('div', { class: 'fixo' }, h('button', { class: 'btn', onclick: addProd, text: 'Adicionar' }))), lista('produtos', estado.produtos)),
    h('div', { class: 'cartao' }, h('h2', { text: 'Lojas' }), h('div', { class: 'linha' }, nomeLojaNova, h('div', { class: 'fixo' }, h('button', { class: 'btn', onclick: addLoja, text: 'Adicionar' }))), lista('lojas', estado.lojas)));
}

iniciar();
