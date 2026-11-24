#!/usr/bin/env node
// Uso: node check-price-history.mjs [slug]        (por defeito: btc-updown-15m-1794760200)
//
// Verifica se a API da Polymarket devolve histórico de preços utilizável para um mercado de 15 min JÁ FECHADO.
//  1) Gamma: obtém os tokenIds (clobTokenIds) do mercado
//  2) CLOB /prices-history: pede o histórico do token "Up" durante a janela, com várias resoluções (fidelity)
// Mostra quantos pontos vêm, de que instantes, e o espaçamento. NÃO envia ordens. Precisa de rede e Node 18+.
// (Não conheço de cor o formato exato da resposta: o script imprime o que recebe e tenta ser tolerante.)
const slug = process.argv[2] || 'btc-updown-15m-1794760200';
const ws = Number(slug.split('-').pop());

async function getJson(url) {
    try {
        const r = await fetch(url);
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* não é JSON */ }
        return { status: r.status, json, text };
    } catch (e) {
        return { status: 0, json: null, text: String(e.message) };
    }
}

console.log(`Mercado: ${slug} (início ${new Date(ws * 1000).toISOString()})\n`);

// 1) Gamma -> tokenIds
const g = await getJson(`https://gamma-api.polymarket.com/markets?slug=${slug}&closed=true`);
const m = Array.isArray(g.json) ? g.json[0] : g.json;
if (!m) { console.log(`Gamma: sem mercado (HTTP ${g.status}). Início da resposta: ${g.text.slice(0, 200)}`); process.exit(0); }
let tokenIds = m.clobTokenIds;
if (typeof tokenIds === 'string') { try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = null; } }
let outcomes = m.outcomes;
if (typeof outcomes === 'string') { try { outcomes = JSON.parse(outcomes); } catch { outcomes = null; } }
if (!Array.isArray(tokenIds) || tokenIds.length < 2) {
    console.log('Gamma: o mercado não trouxe clobTokenIds. Campos disponíveis:', Object.keys(m).join(', '));
    process.exit(0);
}
const iUp = Array.isArray(outcomes) ? outcomes.findIndex((x) => /^up$/i.test(String(x))) : 0;
const upToken = tokenIds[iUp >= 0 ? iUp : 0];
console.log(`Token Up: ${String(upToken).slice(0, 24)}...  (outcomes: ${JSON.stringify(outcomes)})\n`);

// 2) CLOB prices-history, várias resoluções
const startTs = ws - 120, endTs = ws + 900 + 120;
for (const fidelity of [1, 2, 5]) {
    const url = `https://clob.polymarket.com/prices-history?market=${upToken}&startTs=${startTs}&endTs=${endTs}&fidelity=${fidelity}`;
    const r = await getJson(url);
    const hist = Array.isArray(r.json?.history) ? r.json.history : Array.isArray(r.json) ? r.json : null;
    console.log(`fidelity=${fidelity}: HTTP ${r.status} | ${hist ? hist.length + ' pontos' : 'sem lista de pontos'}`);
    if (!hist) { console.log(`   resposta: ${r.text.slice(0, 250).replace(/\s+/g, ' ')}`); continue; }
    if (!hist.length) continue;
    const ts = hist.map((h) => Number(h.t ?? h.timestamp)).filter(isFinite);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
    const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : NaN;
    console.log(`   de ${new Date(ts[0] * 1000).toISOString()} a ${new Date(ts[ts.length - 1] * 1000).toISOString()} | espaçamento mediano ${med}s`);
    console.log(`   amostra: ${JSON.stringify(hist.slice(0, 3))} ... ${JSON.stringify(hist.slice(-2))}`);
}
console.log('\nLeitura:');
console.log(' - uns 15-20 pontos para a janela (1 por minuto) com fidelity=1 => dá para reconstruir o caminho do preço de cada mercado;');
console.log(' - poucos pontos ou espaçamento de minutos/horas => o histórico de mercados fechados é demasiado grosseiro e é preciso gravar ao vivo;');
console.log(' - estes preços são o meio ou o último negócio, NÃO o ask: subestimam o custo real de comprar (spread).');
