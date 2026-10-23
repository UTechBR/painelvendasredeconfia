// Fundo animado da tela de entrada: a "rede" da Rede Confia.
// Diretoria no centro, lojas em volta e consultores orbitando cada loja.
// Os pontos que correm pelas linhas são leads; quando um consultor fecha uma venda,
// ele devolve 3 indicações (pontos laranja) para a rede. Passe o mouse para as lojas
// reagirem; clique (ou toque) para a diretoria disparar leads para todas as lojas.
// Só desenho: nenhum dado do sistema é lido aqui.

const CREME = '247,222,205';
const LARANJA = '255,130,2';
const QTD_LOJAS = 6;

const aleatorio = (a, b) => a + Math.random() * (b - a);
const limitar = (v, a, b) => Math.min(b, Math.max(a, v));
const suave = (t) => t * t * (3 - 2 * t);

function brilho(cor, tamanho) {
  const c = document.createElement('canvas');
  c.width = tamanho; c.height = tamanho;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(tamanho / 2, tamanho / 2, 0, tamanho / 2, tamanho / 2, tamanho / 2);
  g.addColorStop(0, `rgba(${cor},1)`);
  g.addColorStop(0.18, `rgba(${cor},0.65)`);
  g.addColorStop(1, `rgba(${cor},0)`);
  x.fillStyle = g;
  x.fillRect(0, 0, tamanho, tamanho);
  return c;
}

export function iniciarRede(canvas, { marca } = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const reduzido = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const spriteCreme = brilho(CREME, 64);
  const spriteLaranja = brilho(LARANJA, 64);
  const imgMarca = new Image();
  let marcaPronta = false;
  if (marca) { imgMarca.onload = () => { marcaPronta = true; }; imgMarca.src = marca; }

  let W = 0; let H = 0; let dpr = 1;
  let cx = 0; let cy = 0; let R1 = 0; let R2 = 0; let escala = 1;
  const mouse = { x: -9999, y: -9999 };
  const ondas = [];
  const pacotes = [];
  const poeira = Array.from({ length: 46 }, () => ({ x: Math.random(), y: Math.random(), v: aleatorio(0.004, 0.014), r: aleatorio(0.6, 1.6), a: aleatorio(0.12, 0.35) }));
  const hub = { x: 0, y: 0, pulso: 0 };

  const lojas = Array.from({ length: QTD_LOJAS }, (_, i) => {
    const loja = { a0: (i / QTD_LOJAS) * Math.PI * 2 - Math.PI / 2 + 0.25, x: 0, y: 0, ox: 0, oy: 0, vx: 0, vy: 0, pulso: 0, fase: aleatorio(0, 6), cons: [] };
    const n = 3 + Math.floor(Math.random() * 3);
    for (let k = 0; k < n; k++) {
      loja.cons.push({
        loja, ang0: (k / n) * Math.PI * 2 + aleatorio(0, 1), raio: aleatorio(0.8, 1.25),
        vel: aleatorio(0.12, 0.3) * (Math.random() < 0.5 ? -1 : 1),
        x: 0, y: 0, ox: 0, oy: 0, vx: 0, vy: 0, pulso: 0, venda: 0,
      });
    }
    return loja;
  });
  const todos = lojas.flatMap((l) => [l, ...l.cons]);

  function medir() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const estreito = W < 640;
    cx = W * (estreito ? 0.62 : 0.52);
    cy = H * (estreito ? 0.56 : 0.58);
    R1 = Math.min(W * (estreito ? 0.3 : 0.34), H * (estreito ? 0.33 : 0.29));
    R2 = R1 * 0.36;
    escala = limitar(R1 / 150, 0.55, 1.15);
  }

  function posicionar(t) {
    hub.x = cx; hub.y = cy;
    const giro = t * 0.035;
    lojas.forEach((l) => {
      const raio = R1 * (1 + 0.05 * Math.sin(t * 0.5 + l.fase));
      l.bx = cx + Math.cos(l.a0 + giro) * raio;
      l.by = cy + Math.sin(l.a0 + giro) * raio * 0.92;
      l.x = l.bx + l.ox; l.y = l.by + l.oy;
      l.cons.forEach((c) => {
        const a = c.ang0 + t * c.vel;
        c.bx = l.x + Math.cos(a) * R2 * c.raio;
        c.by = l.y + Math.sin(a) * R2 * c.raio;
        c.x = c.bx + c.ox; c.y = c.by + c.oy;
      });
    });
  }

  function mover(dt) {
    const raioMouse = 150 * escala;
    todos.forEach((n) => {
      const dx = n.bx - mouse.x; const dy = n.by - mouse.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < raioMouse) {
        const f = (1 - d / raioMouse) * 520 * escala;
        n.vx += (dx / d) * f * dt; n.vy += (dy / d) * f * dt;
      }
      n.vx += -n.ox * 9 * dt; n.vy += -n.oy * 9 * dt;
      n.vx *= Math.pow(0.04, dt); n.vy *= Math.pow(0.04, dt);
      n.ox += n.vx * dt; n.oy += n.vy * dt;
      n.pulso = Math.max(0, n.pulso - dt * 2.2);
      if (n.venda) n.venda = Math.max(0, n.venda - dt * 0.9);
    });
    hub.pulso = Math.max(0, hub.pulso - dt * 2);
  }

  function enviar(de, para, { dur = 1, cor = 'c', atraso = 0, fim } = {}) {
    if (pacotes.length > 140) return;
    pacotes.push({ de, para, t: -atraso, dur, cor, fim });
  }

  function leadParaLoja() {
    const loja = lojas[Math.floor(Math.random() * lojas.length)];
    hub.pulso = 1;
    enviar(hub, loja, {
      dur: aleatorio(0.9, 1.3),
      fim: () => {
        loja.pulso = 1;
        const c = loja.cons[Math.floor(Math.random() * loja.cons.length)];
        enviar(loja, c, {
          dur: aleatorio(0.7, 1),
          fim: () => {
            c.pulso = 1;
            if (Math.random() < 0.26) venda(c);
          },
        });
      },
    });
  }

  // venda fechada: o consultor devolve 3 indicações, que viajam até a diretoria
  function venda(c) {
    c.venda = 1;
    for (let i = 0; i < 3; i++) {
      enviar(c, c.loja, {
        cor: 'l', dur: 0.75, atraso: i * 0.14,
        fim: () => {
          c.loja.pulso = 1;
          enviar(c.loja, hub, { cor: 'l', dur: aleatorio(0.9, 1.2), fim: () => { hub.pulso = 1; } });
        },
      });
    }
  }

  function rajada(x, y) {
    ondas.push({ x, y, t: 0 });
    lojas.forEach((l, i) => {
      hub.pulso = 1;
      enviar(hub, l, { cor: 'l', dur: 0.9, atraso: i * 0.07, fim: () => { l.pulso = 1; } });
    });
  }

  function avancarPacotes(dt) {
    for (let i = pacotes.length - 1; i >= 0; i--) {
      const p = pacotes[i];
      p.t += dt;
      if (p.t >= p.dur) {
        pacotes.splice(i, 1);
        if (p.fim) p.fim();
      }
    }
    for (let i = ondas.length - 1; i >= 0; i--) {
      ondas[i].t += dt;
      if (ondas[i].t > 1.4) ondas.splice(i, 1);
    }
  }

  function linha(a, b, alfa) {
    ctx.strokeStyle = `rgba(${CREME},${alfa})`;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  function proximidade(n) {
    const d = Math.hypot(n.x - mouse.x, n.y - mouse.y);
    const alcance = 190 * escala;
    return d < alcance ? 1 - d / alcance : 0;
  }

  function desenhar() {
    ctx.clearRect(0, 0, W, H);

    poeira.forEach((p) => {
      ctx.fillStyle = `rgba(${CREME},${p.a})`;
      ctx.beginPath(); ctx.arc(p.x * W, p.y * H, p.r, 0, 6.2832); ctx.fill();
    });

    ctx.lineWidth = 1;
    lojas.forEach((l) => {
      linha(hub, l, 0.2 + proximidade(l) * 0.4);
      l.cons.forEach((c) => linha(l, c, 0.12 + Math.max(proximidade(c), c.venda * 0.5) * 0.4));
    });

    // cursor conectado às 3 peças mais próximas
    if (mouse.x > -999) {
      const perto = todos.map((n) => [n, Math.hypot(n.x - mouse.x, n.y - mouse.y)]).sort((a, b) => a[1] - b[1]).slice(0, 3);
      perto.forEach(([n, d]) => {
        if (d > 220 * escala) return;
        ctx.strokeStyle = `rgba(${LARANJA},${0.55 * (1 - d / (220 * escala))})`;
        ctx.beginPath(); ctx.moveTo(mouse.x, mouse.y); ctx.lineTo(n.x, n.y); ctx.stroke();
      });
      ctx.strokeStyle = `rgba(${CREME},0.45)`;
      ctx.beginPath(); ctx.arc(mouse.x, mouse.y, 9, 0, 6.2832); ctx.stroke();
    }

    ondas.forEach((o) => {
      const k = o.t / 1.4;
      ctx.strokeStyle = `rgba(${LARANJA},${0.5 * (1 - k)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(o.x, o.y, 14 + k * 260 * escala, 0, 6.2832); ctx.stroke();
    });
    ctx.lineWidth = 1;

    todos.forEach((n) => {
      const loja = !n.loja;
      const base = loja ? 6.5 * escala : 3.1 * escala;
      const r = base + n.pulso * (loja ? 4 : 3) * escala;
      const dest = proximidade(n);
      ctx.globalAlpha = 0.95;
      ctx.drawImage(spriteCreme, n.x - r * 3, n.y - r * 3, r * 6, r * 6);
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(${CREME},${(loja ? 0.95 : 0.8) + dest * 0.2})`;
      ctx.beginPath(); ctx.arc(n.x, n.y, r * (1 + dest * 0.2), 0, 6.2832); ctx.fill();
      if (loja) {
        ctx.strokeStyle = `rgba(${CREME},${0.35 + n.pulso * 0.4})`;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 5 * escala + n.pulso * 6, 0, 6.2832); ctx.stroke();
      }
      if (n.venda > 0) {
        ctx.strokeStyle = `rgba(${LARANJA},${n.venda})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + (1 - n.venda) * 26 * escala, 0, 6.2832); ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = `rgba(${LARANJA},${0.4 + n.venda * 0.6})`;
        ctx.beginPath(); ctx.arc(n.x, n.y, r * 0.7, 0, 6.2832); ctx.fill();
      }
    });

    pacotes.forEach((p) => {
      if (p.t < 0) return;
      const k = suave(limitar(p.t / p.dur, 0, 1));
      const x = p.de.x + (p.para.x - p.de.x) * k;
      const y = p.de.y + (p.para.y - p.de.y) * k;
      const r = (p.cor === 'l' ? 9 : 8) * escala;
      ctx.drawImage(p.cor === 'l' ? spriteLaranja : spriteCreme, x - r, y - r, r * 2, r * 2);
      // rastro curto
      const k2 = suave(limitar(p.t / p.dur - 0.08, 0, 1));
      ctx.strokeStyle = `rgba(${p.cor === 'l' ? LARANJA : CREME},0.5)`;
      ctx.beginPath();
      ctx.moveTo(p.de.x + (p.para.x - p.de.x) * k2, p.de.y + (p.para.y - p.de.y) * k2);
      ctx.lineTo(x, y); ctx.stroke();
    });

    // diretoria (centro)
    const hr = 34 * escala + hub.pulso * 6;
    ctx.globalAlpha = 0.6 + hub.pulso * 0.4;
    ctx.drawImage(spriteCreme, hub.x - hr * 3.2, hub.y - hr * 3.2, hr * 6.4, hr * 6.4);
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(105,4,7,0.92)';
    ctx.beginPath(); ctx.arc(hub.x, hub.y, hr, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = `rgba(${CREME},${0.55 + hub.pulso * 0.4})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(hub.x, hub.y, hr, 0, 6.2832); ctx.stroke();
    ctx.beginPath(); ctx.arc(hub.x, hub.y, hr + 8 * escala + hub.pulso * 10, 0, 6.2832);
    ctx.strokeStyle = `rgba(${CREME},${0.22 + hub.pulso * 0.25})`; ctx.stroke();
    ctx.lineWidth = 1;
    if (marcaPronta) {
      const h = hr * 1.15; const w = h * (imgMarca.naturalWidth / imgMarca.naturalHeight);
      ctx.drawImage(imgMarca, hub.x - w / 2, hub.y - h / 2, w, h);
    }
  }

  // ---------- interação ----------
  const ponto = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointermove', (e) => { if (e.pointerType === 'touch') return; Object.assign(mouse, ponto(e)); });
  canvas.addEventListener('pointerleave', () => { mouse.x = -9999; mouse.y = -9999; });
  canvas.addEventListener('pointerdown', (e) => {
    const p = ponto(e);
    if (e.pointerType === 'touch') Object.assign(mouse, p);
    rajada(p.x, p.y);
  });
  canvas.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') { mouse.x = -9999; mouse.y = -9999; } });

  medir();
  if ('ResizeObserver' in window) new ResizeObserver(() => medir()).observe(canvas);
  else window.addEventListener('resize', medir);

  if (reduzido) {
    posicionar(2);
    desenhar();
    imgMarca.addEventListener('load', desenhar);
    return;
  }

  let antes = performance.now();
  let acumulado = 0;
  let t = 0;
  function quadro(agora) {
    if (!canvas.isConnected) return; // a tela mudou: encerra
    const dt = Math.min((agora - antes) / 1000, 0.05);
    antes = agora;
    t += dt;
    acumulado += dt;
    while (acumulado > 0.42) { acumulado -= 0.42; leadParaLoja(); }
    posicionar(t);
    mover(dt);
    avancarPacotes(dt);
    desenhar();
    requestAnimationFrame(quadro);
  }
  for (let i = 0; i < 3; i++) leadParaLoja();
  requestAnimationFrame(quadro);
}
