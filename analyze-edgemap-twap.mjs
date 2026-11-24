#!/usr/bin/env node
// Uso: node analyze-edgemap-twap.mjs [pasta-dos-logs] [--days 30] [--fee 0.0156] [--min-ask 0.05] [--max-ask 0.95]
//
// MAPA DE EDGE sob a regra de resolução confirmada (regra D):
//     Up  se  TWAP60(últimos 60 s)  >=  TWAP60(60 s antes do início da janela)
//
//  1) Lê klines de 1 s da Binance (mesma cache do backtest-twap.mjs) e constrói, POR MOEDA, a tabela empírica
//         P(Up | grupo de minutos, z_D)       z_D = (S − P0) / (σ·√(τ − 40 s))
//     Não usa a fórmula Φ(z): usa as frequências reais (absorve os desvios de calibração que vimos nos backtests).
//     As janelas que aparecem nos teus logs são EXCLUÍDAS da tabela, para a comparação não ser circular.
//  2) Lê dutch-book.jsonl (askUp/askDown + secondsLeft de ~30 em 30 s). O preço S em cada instante vem dos klines de 1 s
//     (não precisa do campo `spot`). Para cada observação calcula
//         edge implícito = P_justa(lado) − ask − fee·ask       e       PnL realizado = (ganhou?1:0) − ask − fee·ask
//  3) Agrega por fase da janela, por faixa de ask e num mapa fase × z do lado comprado.
//
// A Binance (USDT) não é a Chainlink (USD): perto de z=0 sobra incerteza de fonte. Precisa de rede e Node 18+. NÃO envia ordens.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const opt = { days: 30, fee: 0.0156, minAsk: 0.05, maxAsk: 0.95 };
let dirArg = null;
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--days') opt.days = Number(args[++i]);
    else if (a === '--fee') opt.fee = Number(args[++i]);
    else if (a === '--min-ask') opt.minAsk = Number(args[++i]);
    else if (a === '--max-ask') opt.maxAsk = Number(args[++i]);
    else if (!a.startsWith('--') && dirArg === null) dirArg = a;
}
const dir = dirArg || process.env.LOG_DIR || 'logs';
const SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
const SEC = 1000, MIN = 60_000, WIN = 15 * MIN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (x, d = 3) => (x === null || x === undefined || !isFinite(x) ? '-' : Number(x).toFixed(d));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const ci = (a) => (a.length >= 2 ? 1.96 * (sd(a) / Math.sqrt(a.length)) : NaN);

// ───────────── logs ─────────────
const file = path.join(dir, 'dutch-book.jsonl');
if (!existsSync(file)) { console.log(`Ficheiro não encontrado: ${file}`); process.exit(1); }
const logRows = [];
for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
        const r = JSON.parse(line);
        if (r.slug && r.coin && SYMBOL[r.coin] && typeof r.secondsLeft === 'number' && typeof r.askUp === 'number' && typeof r.askDown === 'number') logRows.push(r);
    } catch { /* ignora */ }
}
const coins = [...new Set(logRows.map((r) => r.coin))];
console.log(`Linhas de log: ${logRows.length} | moedas: ${coins.join(', ') || '-'} | fee ${f(opt.fee * 100, 2)}% sobre a entrada (placeholder)`);
if (!coins.length) process.exit(0);

// ───────────── klines de 1 s (mesma cache binária do backtest-twap.mjs) ─────────────
async function load1s(symbol, days) {
    mkdirSync('cache', { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const cacheFile = `cache/klines1s-${symbol}-${days}d-${day}.bin`;
    if (existsSync(cacheFile)) {
        console.log(`  (cache: ${cacheFile})`);
        const buf = readFileSync(cacheFile);
        const t0 = buf.readDoubleLE(0);
        return { t0, closes: new Float64Array(buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + buf.length)) };
    }
    const end = Math.floor(Date.now() / SEC) * SEC;
    const t0 = Math.ceil((end - days * 86_400_000) / WIN) * WIN;
    const n = Math.floor((end - t0) / SEC);
    const closes = new Float64Array(n).fill(NaN);
    const queue = []; for (let s = 0; s < n; s += 1000) queue.push(s);
    const total = queue.length; let done = 0;
    console.log(`  a descarregar ${n} klines de 1 s de ${symbol} (${total} pedidos, 4 em paralelo)...`);
    await Promise.all(Array.from({ length: 4 }, async () => {
        while (queue.length) {
            const s = queue.shift();
            const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1s&startTime=${t0 + s * SEC}&limit=1000`;
            let rows = null;
            for (let a = 0; a < 4 && !rows; a++) {
                try {
                    const r = await fetch(url);
                    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (a + 1)); continue; }
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    rows = await r.json();
                } catch (e) { if (a === 3) throw new Error(`falha a obter klines de 1 s (${e.message})`); await sleep(1000 * (a + 1)); }
            }
            for (const x of rows) { const i = Math.round((Number(x[0]) - t0) / SEC); if (i >= 0 && i < n) closes[i] = Number(x[4]); }
            if (++done % 100 === 0) process.stdout.write(`    ${done}/${total}\r`);
            await sleep(40);
        }
    }));
    process.stdout.write('\n');
    const head = Buffer.alloc(8); head.writeDoubleLE(t0, 0);
    writeFileSync(cacheFile, Buffer.concat([head, Buffer.from(closes.buffer)]));
    return { t0, closes };
}

// ───────────── tabela empírica por moeda ─────────────
const GROUPS = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14]];
const groupOf = (m) => Math.min(GROUPS.length - 1, Math.max(0, Math.ceil(m / 2) - 1));
const ZE = [-1e9, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 1e9];
const zBucket = (z) => { for (let i = 0; i < ZE.length - 1; i++) if (z >= ZE[i] && z < ZE[i + 1]) return i; return -1; };
const MIN_CELL_N = 40;

function makeCoinData({ t0, closes }, excludeWs) {
    const N = closes.length;
    const idx = (t) => Math.round((t - t0) / SEC);
    const at = (i) => { for (let k = 0; k < 5; k++) { const v = closes[i - k]; if (v > 0) return v; } return NaN; };
    const twap = (i0, len) => { let s = 0, c = 0; for (let i = i0; i < i0 + len; i++) { const v = closes[i]; if (v > 0) { s += v; c++; } } return c >= 55 ? s / c : NaN; };
    const sigmaPerSec = (iT) => {
        let sum = 0, n = 0;
        for (let k = 0; k < 60; k++) { const a = at(iT - k * 60), b = at(iT - (k + 1) * 60); if (a > 0 && b > 0) { sum += Math.log(a / b) ** 2; n++; } }
        return n >= 40 ? Math.sqrt(sum / n) / Math.sqrt(60) : NaN;
    };
    const windowInfo = (ws) => {
        const i0 = idx(ws);
        if (i0 < 4000 || i0 + 900 > N) return null;
        const P0 = twap(i0 - 60, 60), fin = twap(i0 + 900 - 60, 60);
        if (!(P0 > 0) || !(fin > 0)) return null;
        return { i0, P0, up: fin >= P0 };
    };
    const cells = GROUPS.map(() => ZE.slice(1).map(() => ({ n: 0, up: 0 })));
    let windows = 0;
    for (let ws = Math.ceil((t0 + 4 * 3_600_000) / WIN) * WIN; ws + WIN <= t0 + N * SEC; ws += WIN) {
        if (excludeWs.has(ws)) continue;
        const w = windowInfo(ws);
        if (!w) continue;
        windows++;
        for (let m = 1; m <= 14; m++) {
            const iT = w.i0 + 60 * m - 1;
            const S = at(iT), s = sigmaPerSec(iT);
            if (!(S > 0) || !(s > 0)) continue;
            const z = (S / w.P0 - 1) / (s * Math.sqrt(900 - 60 * m - 40));
            const b = zBucket(z);
            if (b < 0) continue;
            const c = cells[groupOf(m)][b];
            c.n++; if (w.up) c.up++;
        }
    }
    return { N, t0, idx, at, sigmaPerSec, windowInfo, cells, windows };
}

// janelas que aparecem nos logs, por moeda
const logWs = {};
for (const r of logRows) {
    const ts = Number(String(r.slug).split('-').pop());
    if (!isFinite(ts) || ts < 1.7e9) continue;
    (logWs[r.coin] ??= new Set()).add(ts * 1000);
}

console.log('\nA preparar os dados de 1 s e a tabela empírica por moeda...');
const data = {};
for (const c of coins) {
    console.log(` ${c}:`);
    const raw = await load1s(SYMBOL[c], opt.days);
    data[c] = makeCoinData(raw, logWs[c] ?? new Set());
    console.log(`  ${data[c].windows} janelas históricas na tabela (já sem as ${logWs[c]?.size ?? 0} dos logs)`);
}

// ───────────── observações ─────────────
const skipped = { fora: 0, semKlines: 0, semCelula: 0, ask: 0, aberta: 0 };
const seen = new Set();
const obs = [];
for (const r of logRows) {
    const d = data[r.coin];
    const ts = Number(String(r.slug).split('-').pop());
    if (!d || !isFinite(ts) || ts < 1.7e9) continue;
    const wsMs = ts * 1000;
    if (wsMs + WIN > Date.now()) { skipped.aberta++; continue; }
    const rowMs = Date.parse(r.ts);
    const elapsedMin = 15 - r.secondsLeft / 60;
    if (!isFinite(rowMs) || elapsedMin < 1 || elapsedMin > 14) { skipped.fora++; continue; }
    const mInt = Math.min(14, Math.max(1, Math.round(elapsedMin)));
    const key = `${r.slug}|${mInt}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const w = d.windowInfo(wsMs);
    const iT = Math.floor((rowMs - d.t0) / SEC) - 1;
    if (!w || iT < 0 || iT >= d.N) { skipped.semKlines++; continue; }
    const S = d.at(iT), s = d.sigmaPerSec(iT);
    if (!(S > 0) || !(s > 0)) { skipped.semKlines++; continue; }
    const tau = r.secondsLeft;
    const z = (S / w.P0 - 1) / (s * Math.sqrt(tau - 40));
    const b = zBucket(z);
    const cell = b >= 0 ? d.cells[groupOf(mInt)][b] : null;
    if (!cell || cell.n < MIN_CELL_N) { skipped.semCelula++; continue; }
    const pUp = cell.up / cell.n;

    for (const [side, ask, pFair, won, zSide] of [['Up', r.askUp, pUp, w.up, z], ['Down', r.askDown, 1 - pUp, !w.up, -z]]) {
        if (typeof ask !== 'number' || ask < opt.minAsk || ask > opt.maxAsk) { skipped.ask++; continue; }
        const fee = opt.fee * ask;
        obs.push({ slug: r.slug, coin: r.coin, side, g: groupOf(mInt), ask, pFair, zSide, implied: pFair - ask - fee, realized: (won ? 1 : 0) - ask - fee });
    }
}

console.log(`\nObservações (lado × janela × minuto): ${obs.length} | janelas distintas: ${new Set(obs.map((o) => o.slug)).size}`);
console.log(`Descartadas: sem klines/σ=${skipped.semKlines} | célula com poucos dados=${skipped.semCelula} | fora de 1-14 min=${skipped.fora} | janela por fechar=${skipped.aberta} | ask fora de ${opt.minAsk}-${opt.maxAsk}=${skipped.ask}`);
if (skipped.semKlines > obs.length / 4 && skipped.semKlines > 20) console.log('Nota: muitas linhas sem klines. Se a cache é de antes das linhas mais recentes dos logs, apaga a pasta cache/ e volta a correr.');
if (obs.length < 30) { console.log('Poucas observações para tirar conclusões. Deixa os observadores correr mais dias.'); process.exit(0); }

const head = '   grupo        |     n | ask   | P justa | edge implícito/share  | PnL realizado/share';
const line = (label, s) =>
    `   ${label.padEnd(12)} | ${String(s.length).padStart(5)} | ${f(mean(s.map((o) => o.ask)))} | ${f(mean(s.map((o) => o.pFair)))} | ${(mean(s.map((o) => o.implied)) >= 0 ? '+' : '') + f(mean(s.map((o) => o.implied)), 4)} (±${f(ci(s.map((o) => o.implied)), 4)}) | ${(mean(s.map((o) => o.realized)) >= 0 ? '+' : '') + f(mean(s.map((o) => o.realized)), 4)} (±${f(ci(s.map((o) => o.realized)), 4)})`;

console.log('\n(a) POR FASE DA JANELA (minutos decorridos)');
console.log(head);
for (let g = 0; g < GROUPS.length; g++) { const s = obs.filter((o) => o.g === g); if (s.length >= 20) console.log(line(`min ${GROUPS[g][0]}-${GROUPS[g][1]}`, s)); }
console.log(line('TODAS', obs));

console.log('\n(b) POR FAIXA DE ASK');
console.log(head);
const AE = [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1.01];
for (let i = 0; i < AE.length - 1; i++) { const s = obs.filter((o) => o.ask >= AE[i] && o.ask < AE[i + 1]); if (s.length >= 20) console.log(line(`${f(AE[i], 2)}-${f(Math.min(AE[i + 1], 1), 2)}`, s)); }

// (c) o mercado é mais ou menos confiante do que a frequência histórica? (lado favorito segundo a tabela)
console.log('\n(c) O MERCADO É MAIS CONFIANTE DO QUE A HISTÓRIA? (só o lado favorito: P justa >= 0.5)');
console.log('   grupo        |     n | ask médio | P justa média | ask − P justa');
for (let g = 0; g < GROUPS.length; g++) {
    const s = obs.filter((o) => o.g === g && o.pFair >= 0.5);
    if (s.length >= 20) console.log(`   ${(`min ${GROUPS[g][0]}-${GROUPS[g][1]}`).padEnd(12)} | ${String(s.length).padStart(5)} | ${f(mean(s.map((o) => o.ask)))}     | ${f(mean(s.map((o) => o.pFair)))}         | ${(mean(s.map((o) => o.ask - o.pFair)) >= 0 ? '+' : '') + f(mean(s.map((o) => o.ask - o.pFair)), 3)}`);
}
console.log('   → ask − P justa > 0 no favorito: o mercado cobra MAIS do que a frequência histórica (mais confiante, ou com prémio/spread).');

// (d) mapa fase × z do lado comprado
console.log('\n(d) MAPA DE EDGE IMPLÍCITO (pontos por share; n entre parênteses). Colunas: z do LADO COMPRADO (z>0 = a favor)');
const ZS = [-1e9, -1, -0.5, 0, 0.5, 1, 2, 1e9];
const zsLab = (i) => (i === 0 ? 'z<-1' : i === ZS.length - 2 ? 'z>=2' : `${ZS[i]}..${ZS[i + 1]}`);
console.log('   ' + 'fase'.padEnd(10) + ZS.slice(0, -1).map((_, i) => zsLab(i).padStart(14)).join(''));
const best = [];
for (let g = 0; g < GROUPS.length; g++) {
    let out = `   ${(`min ${GROUPS[g][0]}-${GROUPS[g][1]}`).padEnd(10)}`;
    for (let i = 0; i < ZS.length - 1; i++) {
        const s = obs.filter((o) => o.g === g && o.zSide >= ZS[i] && o.zSide < ZS[i + 1]);
        if (s.length < 10) { out += '-'.padStart(14); continue; }
        const e = mean(s.map((o) => o.implied)) * 100;
        out += `${(e >= 0 ? '+' : '') + f(e, 1)}(${s.length})`.padStart(14);
        best.push({ cell: `min ${GROUPS[g][0]}-${GROUPS[g][1]} × ${zsLab(i)}`, e, c: ci(s.map((o) => o.implied)) * 100, n: s.length, ask: mean(s.map((o) => o.ask)), real: mean(s.map((o) => o.realized)) });
    }
    console.log(out);
}
console.log('\n(e) MELHORES CÉLULAS (n>=20), por edge implícito');
for (const b of best.filter((x) => x.n >= 20).sort((a, b) => b.e - a.e).slice(0, 5)) {
    console.log(`   ${b.cell.padEnd(24)} n=${String(b.n).padStart(4)} ask médio=${f(b.ask, 2)} edge=${(b.e >= 0 ? '+' : '') + f(b.e, 1)} pts (±${f(b.c, 1)}) | PnL realizado=${(b.real >= 0 ? '+' : '') + f(b.real * 100, 1)} pts`);
}
console.log('\nLeitura:');
console.log(' - edge implícito > 0 com o intervalo longe de 0, em células vizinhas coerentes e em dias diferentes, é o que se procura;');
console.log(' - o PnL realizado deve acompanhar o implícito: se não acompanhar, o "edge" não se materializa;');
console.log(' - limitações: P justa da Binance (não da Chainlink), fee placeholder, amostragem de 30 s, janelas correlacionadas entre moedas (IC otimistas).');
