// xlsx.js — leitor mínimo de .xlsx (primeira aba), sem biblioteca externa.
// Usa só recursos do navegador (DecompressionStream e DOMParser). Não lê .xls antigo.

const LIMITE_BYTES = 60 * 1024 * 1024; // proteção contra arquivo zipado gigante

function textoUtf8(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

async function descompactar(bytes) {
  const fluxo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(fluxo).text();
}

function indiceColuna(ref) {
  const letras = /^[A-Z]+/.exec(ref)?.[0] || 'A';
  let n = 0;
  for (const ch of letras) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function lerZip(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Este arquivo não parece ser um .xlsx. Salve como .xlsx ou .csv e tente de novo.');
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const arquivos = {};
  for (let i = 0; i < total; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Arquivo .xlsx danificado.');
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const nome = textoUtf8(u8.subarray(p + 46, p + 46 + nlen));
    arquivos[nome] = {
      metodo: dv.getUint16(p + 10, true),
      csize: dv.getUint32(p + 20, true),
      usize: dv.getUint32(p + 24, true),
      off: dv.getUint32(p + 42, true),
    };
    p += 46 + nlen + elen + clen;
  }
  return async (nome) => {
    const f = arquivos[nome];
    if (!f) return null;
    if (f.usize > LIMITE_BYTES) throw new Error('Arquivo grande demais para importar.');
    const nlen = dv.getUint16(f.off + 26, true);
    const elen = dv.getUint16(f.off + 28, true);
    const ini = f.off + 30 + nlen + elen;
    const dados = u8.subarray(ini, ini + f.csize);
    if (f.metodo === 0) return textoUtf8(dados);
    if (f.metodo !== 8) throw new Error('Compactação do .xlsx não suportada.');
    return descompactar(dados);
  };
}

const xml = (texto) => new DOMParser().parseFromString(texto, 'application/xml');

export async function lerXlsx(buffer) {
  const ler = lerZip(buffer);

  // primeira aba, pela ordem do workbook
  let caminho = 'xl/worksheets/sheet1.xml';
  const wb = await ler('xl/workbook.xml');
  const rels = await ler('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const primeira = xml(wb).getElementsByTagName('sheet')[0];
    const rid = primeira?.getAttribute('r:id');
    for (const r of xml(rels).getElementsByTagName('Relationship')) {
      if (r.getAttribute('Id') === rid) {
        const alvo = r.getAttribute('Target');
        caminho = alvo.startsWith('/') ? alvo.slice(1) : `xl/${alvo}`;
      }
    }
  }
  const planilha = await ler(caminho);
  if (!planilha) throw new Error('Não encontrei a primeira aba no arquivo.');

  const compartilhadas = [];
  const ss = await ler('xl/sharedStrings.xml');
  if (ss) {
    for (const si of xml(ss).getElementsByTagName('si')) {
      compartilhadas.push(Array.from(si.getElementsByTagName('t')).map((t) => t.textContent).join(''));
    }
  }

  const linhas = [];
  for (const row of xml(planilha).getElementsByTagName('row')) {
    const linha = [];
    for (const c of row.getElementsByTagName('c')) {
      const col = indiceColuna(c.getAttribute('r') || 'A1');
      const tipo = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      let valor = v;
      if (tipo === 's') valor = compartilhadas[Number(v)] ?? '';
      else if (tipo === 'inlineStr') valor = Array.from(c.getElementsByTagName('t')).map((t) => t.textContent).join('');
      else if (tipo === 'b') valor = v === '1' ? 'VERDADEIRO' : 'FALSO';
      else if (tipo !== 'str' && /e/i.test(v) && !Number.isNaN(Number(v))) valor = String(Number(v));
      linha[col] = valor;
    }
    for (let i = 0; i < linha.length; i++) if (linha[i] === undefined) linha[i] = '';
    linhas.push(linha);
  }
  return linhas.filter((l) => l.some((x) => String(x).trim() !== ''));
}
