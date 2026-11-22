const slug = process.argv[2] || 'btc-updown-15m-1794760200';
const base = 'https://gamma-api.polymarket.com';
const variants = [
  `/markets?slug=${slug}`,
  `/markets?slug=${slug}&closed=true`,
  `/events?slug=${slug}`,
  `/events?slug=${slug}&closed=true`,
];
for (const v of variants) {
  try {
    const r = await fetch(base + v);
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    const arr = Array.isArray(j) ? j : j ? [j] : [];
    console.log(`\n${v}\n  HTTP ${r.status} | ${text.length} bytes | itens: ${arr.length}`);
    if (!j) console.log('  resposta não é JSON. Início: ' + text.slice(0, 200).replace(/\s+/g, ' '));
    for (const it of arr.slice(0, 1)) {
      const m = (Array.isArray(it.markets) && it.markets[0]) || it;
      console.log(JSON.stringify({
        slug: it.slug,
        titulo: it.title ?? it.question,
        closed: it.closed ?? m.closed,
        outcomes: m.outcomes,
        outcomePrices: m.outcomePrices,
        umaResolutionStatus: m.umaResolutionStatus,
        endDate: it.endDate ?? m.endDate,
        description: String(it.description ?? m.description ?? '').slice(0, 900),
      }, null, 2));
    }
  } catch (e) {
    console.log(`\n${v}\n  erro: ${e.message}`);
  }
}
