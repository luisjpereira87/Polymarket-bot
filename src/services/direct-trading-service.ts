import { appendFile, mkdir } from 'fs/promises';
import { SmartMoneyTrade, TradePositions } from '../index.js';
import { BinanceService, BinanceSymbol } from './binance-service.js';
import { MarketService } from './market-service.js';
import { OrderbookService } from './orderbook-service.js';
import { TradingService } from './trading-service.js';

export interface DirectTradingServiceConfig {
    enabled: boolean;
    interval: string;         // ex: '15m' (mantido por compatibilidade, o modelo usa sempre 15m)
    trendThreshold: number;   // já não é usado (mantido por compatibilidade)
    amount: () => number;     // ex: 5 (USDC)
    dryRun?: boolean;
    checkIntervalMs?: number; // ex: 5000 (agora corre a cada ~5 s dentro da janela de entrada)
    isCanTrade: () => boolean;
    positions: () => Map<string, TradePositions>;
}

export interface OrderBookValidationResult {
    isValid: boolean;
    averageExecutionPrice: number;
    maxPriceTouched: number;
    totalShares: number;
    reason?: string;
}

interface ClobOrderBookResponse {
    market?: string;
    asset_id?: string;
    bids?: Array<{ price: string; size: string }>;
    asks?: Array<{ price: string; size: string }>;
    min_order_size?: string;
    tick_size?: string;
    neg_risk?: boolean;
    last_trade_price?: string;
}

export type DirectTradingCallback = (trade: any, result: any) => Promise<void> | void;

type Coin = 'BTC' | 'ETH' | 'SOL';

interface CachedMarket {
    market: any;
    fullMarket: any;
    startMs: number;
    endMs: number;
}

interface Candidate {
    coin: Coin;
    market: any;
    targetToken: any;
    direction: 'up' | 'down';
    validation: OrderBookValidationResult;
    open: number;
    spot: number;
    secondsLeft: number;
    sigma: number;
    pTarget: number;
    edge: number;
    endDate: Date;
}

// ───────────────────────── Parâmetros do modelo ─────────────────────────
const WINDOW_MS = 15 * 60 * 1000;

// Janela de entrada (segundos que faltam para fechar a vela de 15m)
const MIN_SECONDS_LEFT = 45;
const MAX_SECONDS_LEFT = 300;

// Modelo
const SIGMA_INFLATE = 1.2;     // caudas gordas / incerteza do modelo
const MAX_P_TARGET = 0.95;     // limita a confiança do modelo
const MIN_P_PREFILTER = 0.60;  // abaixo disto nem vale a pena ir ao book

// Preço / edge
const MAX_ENTRY_PRICE = 0.85;  // acima disto: mercado praticamente resolvido
const MIN_ENTRY_PRICE = 0.15;  // abaixo disto: lotaria
const MIN_PAYOFF_RATIO = 0.15; // (1 - preço) / preço
const FEE = 0.01;              // CONFIRMA as fees reais do mercado
const MIN_EDGE = 0.06;         // edge mínimo depois de fees

// Parâmetros que já passavas ao validateOrderBookSlippage.
// CONFIRMA o significado (assumi: preço máximo e preço mínimo aceitáveis).
const BOOK_PARAM_A = 0.75;
const BOOK_PARAM_B = 0.25;

// Risco
const MAX_POSITIONS_PER_WINDOW = 1; // BTC/ETH/SOL estão muito correlacionados

// Logs para calibração
const EDGE_LOG_DIR = 'logs';
const EDGE_LOG_FILE = `${EDGE_LOG_DIR}/edge-log.jsonl`;
const SKIP_LOG_THROTTLE_MS = 15_000;

const SYMBOL_MAP: Record<'BTC' | 'ETH' | 'SOL', any> = {
    BTC: 'BTCUSDT',
    ETH: 'ETHUSDT',
    SOL: 'SOLUSDT'
};

export class DirectTradingService {
    private marketService: MarketService;
    private tradingService: TradingService;
    private binanceService: BinanceService;
    private orderbookService: OrderbookService;

    private timer: NodeJS.Timeout | null = null;
    private running = false;   // evita sobreposição de ciclos
    private stopped = true;

    private marketCache = new Map<Coin, CachedMarket>();
    private sigmaCache = new Map<string, { minute: number; value: number }>();
    private tradedWindows = new Set<number>();            // endMs das janelas onde já entrámos
    private tradesInWindow = new Map<number, number>();   // endMs -> nº de trades
    private lastSkipLog = new Map<string, number>();
    private logDirReady = false;

    // Observabilidade
    private stats = new Map<string, number>();   // motivo -> nº de rejeições desde o último heartbeat
    private evaluations = 0;                     // nº de avaliações desde o último heartbeat
    private lastHeartbeat = 0;
    private lastIdleLog = 0;
    private lastEvalLog = new Map<string, number>();

    constructor(
        tradingService: TradingService,
        marketService: MarketService,
        binanceService: BinanceService,
        orderbookService: OrderbookService
    ) {
        this.tradingService = tradingService;
        this.marketService = marketService;
        this.binanceService = binanceService;
        this.orderbookService = orderbookService;
    }

    /**
     * Inicia o serviço. Corre a cada ~5 s, mas só faz trabalho pesado
     * quando faltam entre MIN_SECONDS_LEFT e MAX_SECONDS_LEFT para fechar a vela de 15m.
     */
    public async startTradingLoop(
        config: DirectTradingServiceConfig,
        options: { onTrade: DirectTradingCallback }
    ) {
        if (!config.enabled) {
            console.log('TREND', 'Serviço de Direct Trading está desativado na configuração.');
            return;
        }

        console.log('TREND', '🚀 A iniciar Direct Trading Service (modelo de probabilidade + edge, Binance + Polymarket)...');

        this.stopped = false;
        const intervalMs = config.checkIntervalMs || 5000;

        console.log(
            'TREND',
            `⚙️ Parâmetros: janela ${MIN_SECONDS_LEFT}-${MAX_SECONDS_LEFT}s | preço ${MIN_ENTRY_PRICE}-${MAX_ENTRY_PRICE} | edge mín ${MIN_EDGE} | fee ${FEE} | p máx ${MAX_P_TARGET} | ciclo ${intervalMs}ms | dryRun=${config.dryRun ?? false}`
        );

        const tick = async () => {
            if (this.stopped) return;

            if (!this.running) {
                this.running = true;
                try {
                    await this.executeCycle(config, options.onTrade);
                } catch (err) {
                    console.log('ERROR', `❌ Erro no ciclo: ${(err as Error).message}`);
                } finally {
                    this.running = false;
                }
            }

            if (!this.stopped) {
                this.timer = setTimeout(tick, intervalMs);
            }
        };

        this.timer = setTimeout(tick, 0);

        return {
            unsubscribe: () => this.stop()
        };
    }

    public stop() {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        console.log('TREND', '🛑 Direct Trading Service parado.');
    }

    // ───────────────────────── Ciclo principal ─────────────────────────

    private async executeCycle(config: DirectTradingServiceConfig, onTrade: DirectTradingCallback) {
        const now = Date.now();

        // isCanTrade passa a ser avaliado em cada ciclo
        if (config.isCanTrade && !config.isCanTrade()) {
            if (now - this.lastIdleLog > 30_000) {
                this.lastIdleLog = now;
                console.log('TREND', '⏸️ isCanTrade() = false. Sem avaliações.');
            }
            return;
        }

        // Filtro barato pelo relógio: sem chamadas à rede fora da janela de entrada
        const windowStartMs = Math.floor(now / WINDOW_MS) * WINDOW_MS;
        const windowEndMs = windowStartMs + WINDOW_MS;
        const secondsLeft = (windowEndMs - now) / 1000;

        if (secondsLeft < MIN_SECONDS_LEFT || secondsLeft > MAX_SECONDS_LEFT) {
            if (now - this.lastIdleLog > 60_000) {
                this.lastIdleLog = now;
                const untilEntry = secondsLeft > MAX_SECONDS_LEFT
                    ? secondsLeft - MAX_SECONDS_LEFT
                    : secondsLeft + WINDOW_MS / 1000 - MAX_SECONDS_LEFT;
                console.log('TREND', `💤 Fora da janela de entrada (faltam ${secondsLeft.toFixed(0)}s para fechar a vela). Próxima janela de avaliação em ~${untilEntry.toFixed(0)}s.`);
            }
            return;
        }

        this.heartbeat(secondsLeft);

        // Limpeza de estado de janelas antigas
        for (const end of this.tradedWindows) {
            if (end < now - WINDOW_MS) this.tradedWindows.delete(end);
        }
        for (const end of this.tradesInWindow.keys()) {
            if (end < now - WINDOW_MS) this.tradesInWindow.delete(end);
        }

        if ((this.tradesInWindow.get(windowEndMs) ?? 0) >= MAX_POSITIONS_PER_WINDOW) {
            if (now - this.lastIdleLog > 30_000) {
                this.lastIdleLog = now;
                console.log('TREND', `✋ Janela já tem ${MAX_POSITIONS_PER_WINDOW} posição(ões). A aguardar a próxima.`);
            }
            return;
        }

        const coins: Coin[] = ['BTC', 'ETH', 'SOL'];

        // Avalia as 3 moedas e escolhe a de maior edge (1 posição por janela)
        const candidates: Candidate[] = [];
        for (const coin of coins) {
            try {
                const c = await this.evaluateCoin(coin, config, windowStartMs, windowEndMs);
                if (c) candidates.push(c);
            } catch (err) {
                console.log('ERROR', `❌ Erro a avaliar ${coin}: ${(err as Error).message}`);
            }
        }

        if (candidates.length === 0) return;

        candidates.sort((a, b) => b.edge - a.edge);
        const best = candidates[0];

        await this.executeCandidate(best, config, onTrade, windowEndMs);
    }

    // ───────────────────────── Avaliação por moeda ─────────────────────────

    private async evaluateCoin(
        coin: Coin,
        config: DirectTradingServiceConfig,
        windowStartMs: number,
        windowEndMs: number
    ): Promise<Candidate | null> {
        const symbol = SYMBOL_MAP[coin];
        const secondsLeft = (windowEndMs - Date.now()) / 1000;
        if (secondsLeft < MIN_SECONDS_LEFT || secondsLeft > MAX_SECONDS_LEFT) return null;

        // 1. Open da vela de 15m e preço atual (vela em curso)
        const klines = await this.binanceService.getKLines(symbol, '15m' as any, { limit: 2 });
        if (!klines || klines.length < 1) {
            console.log('WARN', `⚠️ Klines em falta para ${symbol}`);
            return null;
        }
        const cur: any = klines[klines.length - 1];

        // Sanidade: a última vela tem de ser a da janela atual (se o campo existir)
        const kOpenTime = Number(cur.openTime ?? cur.time ?? cur.openTimeMs ?? 0);
        if (kOpenTime > 0 && Math.abs(kOpenTime - windowStartMs) > 5000) {
            console.log('WARN', `⚠️ [${coin}] Última vela (${new Date(kOpenTime).toISOString()}) não corresponde à janela atual. A ignorar.`);
            return null;
        }

        const open = Number(cur.open);
        const spot = Number(cur.close);
        if (!isFinite(open) || !isFinite(spot) || open <= 0 || spot <= 0) return null;

        // 2. Probabilidade de fechar verde
        const sigma = await this.getSigmaPerSec(symbol);
        if (!isFinite(sigma) || sigma <= 0) {
            this.logSkip(coin, 'sigma_invalido', { open, spot, secondsLeft, sigma });
            return null;
        }

        this.evaluations++;

        const pUp = this.computePUp(open, spot, secondsLeft, sigma);
        const direction: 'up' | 'down' = pUp >= 0.5 ? 'up' : 'down';
        const pTarget = direction === 'up' ? pUp : 1 - pUp;
        const pCapped = Math.min(pTarget, MAX_P_TARGET);

        // Linha de avaliação (uma a cada 10 s por moeda), para veres que o bot está a trabalhar
        {
            const now = Date.now();
            if (now - (this.lastEvalLog.get(coin) ?? 0) >= 10_000) {
                this.lastEvalLog.set(coin, now);
                const movePct = ((spot - open) / open) * 100;
                console.log(
                    'EVAL',
                    `🔎 [${coin}] open=${open} spot=${spot} (${movePct >= 0 ? '+' : ''}${movePct.toFixed(3)}%) | σ/s=${sigma.toExponential(2)} | faltam ${secondsLeft.toFixed(0)}s | p(${direction})=${pTarget.toFixed(3)}`
                );
            }
        }

        if (pCapped < MIN_P_PREFILTER) {
            this.logSkip(coin, 'p_baixo', { open, spot, secondsLeft, sigma, pTarget });
            return null;
        }

        // 3. Mercado da Polymarket (em cache por janela)
        const cached = await this.getMarketForWindow(coin, windowStartMs, windowEndMs);
        if (!cached) return null;
        const { market, fullMarket } = cached;

        const yesToken = fullMarket.tokens.find((t: any) => t.outcome === 'Up' || t.outcome === 'Yes');
        const noToken = fullMarket.tokens.find((t: any) => t.outcome === 'Down' || t.outcome === 'No');
        const targetToken = direction === 'up' ? yesToken : noToken;

        if (!targetToken) {
            console.log('WARN', `⚠️ Token de destino ('${direction === 'up' ? 'Up/Yes' : 'Down/No'}') não encontrado para ${coin}`);
            return null;
        }

        // 4. Anti-duplicação: UMA posição por mercado (qualquer outcome)
        const currentPositions = typeof config.positions === 'function' ? config.positions() : null;
        if (currentPositions) {
            for (const key of currentPositions.keys()) {
                if (key.startsWith(market.slug)) {
                    this.logSkip(coin, 'posicao_duplicada', { slug: market.slug, key });
                    return null;
                }
            }
        }

        // 5. Validar o book real
        const amountUsdc = config.amount() || 5;
        const validation: OrderBookValidationResult = await this.orderbookService.validateOrderBookSlippage(
            targetToken.tokenId,
            amountUsdc,
            BOOK_PARAM_A,
            BOOK_PARAM_B
        );

        if (!validation.isValid) {
            this.logSkip(coin, 'book_invalido', { open, spot, secondsLeft, sigma, pTarget, reason: validation.reason });
            return null;
        }

        const avgPrice = validation.averageExecutionPrice;

        // 6. Filtros de "mercado praticamente resolvido"
        if (avgPrice > MAX_ENTRY_PRICE || avgPrice < MIN_ENTRY_PRICE) {
            this.logSkip(coin, 'quase_resolvido', { open, spot, secondsLeft, sigma, pTarget, avgPrice });
            return null;
        }

        const payoffRatio = (1 - avgPrice) / avgPrice;
        if (payoffRatio < MIN_PAYOFF_RATIO) {
            this.logSkip(coin, 'payoff_baixo', { open, spot, secondsLeft, sigma, pTarget, avgPrice, payoffRatio });
            return null;
        }

        // 7. Edge (com a confiança limitada)
        const edge = pCapped - avgPrice - FEE;
        if (edge < MIN_EDGE) {
            this.logSkip(coin, 'edge_baixo', { open, spot, secondsLeft, sigma, pTarget, avgPrice, edge });
            return null;
        }

        const rawEndDate = market.endDate || fullMarket.endDate;
        const endDate = rawEndDate ? new Date(rawEndDate) : new Date(windowEndMs);

        console.log(
            'SIGNAL',
            `🎯 [${coin}] ${direction.toUpperCase()} | p=${pTarget.toFixed(3)} | preço=${avgPrice.toFixed(3)} | edge=${edge.toFixed(3)} | faltam ${secondsLeft.toFixed(0)}s`
        );

        return {
            coin,
            market,
            targetToken,
            direction,
            validation,
            open,
            spot,
            secondsLeft,
            sigma,
            pTarget,
            edge,
            endDate
        };
    }

    // ───────────────────────── Execução ─────────────────────────

    private async executeCandidate(
        c: Candidate,
        config: DirectTradingServiceConfig,
        onTrade: DirectTradingCallback,
        windowEndMs: number
    ) {
        const { coin, market, targetToken, direction, validation } = c;
        const amountUsdc = config.amount() || 5;

        const syntheticTrade: SmartMoneyTrade = {
            traderAddress: `ProbEdge-${coin}`,
            marketSlug: market.slug,
            side: 'BUY',
            size: validation.totalShares,
            price: validation.averageExecutionPrice,
            tokenId: targetToken.tokenId,
            conditionId: market.conditionId,
            traderName: `Edge Bot (${coin})`,
            timestamp: Date.now(),
            isSmartMoney: false,
            endDate: c.endDate,
            outcome: targetToken.outcome
        };

        const isDryRun = config.dryRun ?? false;

        // Marca a janela como usada antes de submeter, para nunca duplicar
        this.tradesInWindow.set(windowEndMs, (this.tradesInWindow.get(windowEndMs) ?? 0) + 1);

        const logBase = {
            ts: new Date().toISOString(),
            type: 'entry',
            coin,
            slug: market.slug,
            direction,
            open: c.open,
            spot: c.spot,
            secondsLeft: Number(c.secondsLeft.toFixed(1)),
            sigma: c.sigma,
            pTarget: Number(c.pTarget.toFixed(4)),
            avgPrice: Number(validation.averageExecutionPrice.toFixed(4)),
            maxPriceTouched: validation.maxPriceTouched,
            edge: Number(c.edge.toFixed(4)),
            shares: validation.totalShares,
            amountUsdc,
            dryRun: isDryRun
        };

        if (isDryRun) {
            console.log('SIGNAL', `🧪 [DRY RUN] Trade (${coin}): ${direction.toUpperCase()} em ${market.question?.slice(0, 30)}...`);
            await this.writeLog(logBase);
            await onTrade(syntheticTrade, { success: true });
            return;
        }

        console.log('SIGNAL', `🔴 Executando Trade Real (${coin}): ${direction.toUpperCase()} em ${market.question?.slice(0, 30)}...`);

        try {
            const res = await this.tradingService.createMarketOrder({
                tokenId: targetToken.tokenId,
                side: 'BUY',
                amount: amountUsdc
            });

            await this.writeLog({ ...logBase, success: !!res?.success, error: res?.errorMsg });
            await onTrade(syntheticTrade, res);

            if (res && res.success) {
                console.log('TRADE', `✅ Trade Executado (${coin}): Compra de $${amountUsdc} em ${targetToken.outcome}`);
            } else {
                console.log('WARN', `❌ Trade falhou: ${res?.errorMsg || 'Erro desconhecido'}`);
                // Falhou: liberta a janela para nova tentativa
                this.tradesInWindow.set(windowEndMs, Math.max(0, (this.tradesInWindow.get(windowEndMs) ?? 1) - 1));
            }
        } catch (orderErr) {
            console.log('ERROR', `❌ Erro crítico ao submeter ordem: ${(orderErr as Error).message}`);
            this.tradesInWindow.set(windowEndMs, Math.max(0, (this.tradesInWindow.get(windowEndMs) ?? 1) - 1));
        }
    }

    // ───────────────────────── Modelo ─────────────────────────

    private normCdf(x: number): number {
        const t = 1 / (1 + 0.2316419 * Math.abs(x));
        const d = 0.3989423 * Math.exp((-x * x) / 2);
        const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
        return x > 0 ? 1 - p : p;
    }

    /**
     * Probabilidade de a vela fechar com close >= open.
     * Movimento browniano sem drift, com σ inflacionado.
     */
    private computePUp(open: number, spot: number, secondsLeft: number, sigmaPerSec: number): number {
        const sd = sigmaPerSec * SIGMA_INFLATE * Math.sqrt(secondsLeft) * spot;
        if (sd === 0) return spot >= open ? 1 : 0;
        return this.normCdf((spot - open) / sd);
    }

    /**
     * σ por segundo a partir de klines de 1m (ignora a vela em curso).
     * Mistura janela curta (15 min) e longa (2 h). Em cache por minuto.
     */
    private async getSigmaPerSec(symbol: BinanceSymbol): Promise<number> {
        const minute = Math.floor(Date.now() / 60000);
        const cached = this.sigmaCache.get(symbol);
        if (cached && cached.minute === minute) return cached.value;

        const k = await this.binanceService.getKLines(symbol, '1m' as any, { limit: 121 });
        if (!k || k.length < 30) return cached?.value ?? NaN;

        const closed = k.slice(0, -1);
        const rets: number[] = [];
        for (let i = 1; i < closed.length; i++) {
            const r = Math.log(Number((closed[i] as any).close) / Number((closed[i - 1] as any).close));
            if (isFinite(r)) rets.push(r);
        }
        if (rets.length < 20) return cached?.value ?? NaN;

        const sigmaOf = (arr: number[]) => {
            const v = arr.reduce((s, r) => s + r * r, 0) / arr.length; // variância por minuto
            return Math.sqrt(v / 60);                                  // por segundo
        };

        const shortSigma = sigmaOf(rets.slice(-15));
        const longSigma = sigmaOf(rets);
        const value = (shortSigma + longSigma) / 2;

        this.sigmaCache.set(symbol, { minute, value });
        return value;
    }

    // ───────────────────────── Mercado Polymarket ─────────────────────────

    private async getMarketForWindow(
        coin: Coin,
        windowStartMs: number,
        windowEndMs: number
    ): Promise<CachedMarket | null> {
        const cached = this.marketCache.get(coin);
        if (cached && cached.endMs === windowEndMs) return cached;

        const markets = await this.marketService.scanCryptoShortTermMarkets({
            coin,
            duration: '15m',
            minMinutesUntilEnd: 0,   // antes era 2: bloqueava os últimos 2 min
            maxMinutesUntilEnd: 20,
            limit: 1,
            sortBy: 'endDate'
        });

        if (!markets || markets.length === 0) {
            console.log('WARN', `⚠️ Nenhum mercado de curto prazo encontrado na Polymarket para ${coin}`);
            return null;
        }

        const market = markets[0];
        if (!market.conditionId) return null;

        const win = this.getMarketWindow(market);
        if (!win) {
            console.log('WARN', `⚠️ [${coin}] Impossível determinar a janela do mercado (${market.slug}).`);
            return null;
        }

        // O mercado tem de ser o da janela atual
        if (Math.abs(win.endMs - windowEndMs) > 5000) {
            console.log('WARN', `⏳ [${coin}] Mercado ${market.slug} não corresponde à janela atual. A ignorar.`);
            return null;
        }

        const fullMarket = await this.marketService.getMarket(market.conditionId);
        if (!fullMarket?.tokens) return null;

        const entry: CachedMarket = { market, fullMarket, startMs: win.startMs, endMs: windowEndMs };
        this.marketCache.set(coin, entry);
        return entry;
    }

    private getMarketWindow(market: any): { startMs: number; endMs: number } | null {
        let startMs = 0;
        let endMs = 0;

        // Slug tipo 'eth-updown-15m-1790708400' -> timestamp = INÍCIO
        if (market.slug) {
            const parts = String(market.slug).split('-');
            const ts = Number(parts[parts.length - 1]);
            if (!isNaN(ts) && ts > 1700000000) {
                startMs = ts * 1000;
                endMs = startMs + WINDOW_MS;
            }
        }

        if (!endMs && market.endDate) {
            endMs = new Date(market.endDate).getTime();
            startMs = endMs - WINDOW_MS;
        }

        if (!endMs || isNaN(endMs)) return null;
        return { startMs, endMs };
    }

    // ───────────────────────── Logs ─────────────────────────

    private logSkip(coin: Coin, reason: string, data: Record<string, any>) {
        // Conta sempre, mesmo quando o log está limitado
        this.stats.set(reason, (this.stats.get(reason) ?? 0) + 1);

        const key = `${coin}:${reason}`;
        const now = Date.now();
        const last = this.lastSkipLog.get(key) ?? 0;
        if (now - last < SKIP_LOG_THROTTLE_MS) return;
        this.lastSkipLog.set(key, now);

        const details = Object.entries(data)
            .map(([k, v]) => `${k}=${typeof v === 'number' ? Number(v.toFixed(4)) : v}`)
            .join(' ');
        console.log('SKIP', `⏭️ [${coin}] ${reason} | ${details}`);

        void this.writeLog({ ts: new Date().toISOString(), type: 'skip', coin, reason, ...data });
    }

    /**
     * Resumo a cada 30 s: quantas avaliações houve e porque foram rejeitadas.
     * Se vires "avaliações=0" o problema está antes do modelo (dados, mercado, janela).
     */
    private heartbeat(secondsLeft: number) {
        const now = Date.now();
        if (now - this.lastHeartbeat < 30_000) return;
        this.lastHeartbeat = now;

        const reasons = [...this.stats.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([r, n]) => `${r}=${n}`)
            .join(', ') || 'nenhuma';

        console.log(
            'TREND',
            `💓 Heartbeat | faltam ${secondsLeft.toFixed(0)}s | avaliações=${this.evaluations} | rejeições: ${reasons}`
        );

        this.stats.clear();
        this.evaluations = 0;
    }

    private async writeLog(entry: Record<string, any>) {
        try {
            if (!this.logDirReady) {
                await mkdir(EDGE_LOG_DIR, { recursive: true });
                this.logDirReady = true;
            }
            await appendFile(EDGE_LOG_FILE, JSON.stringify(entry) + '\n');
        } catch (err) {
            console.log('WARN', `⚠️ Falha a escrever log: ${(err as Error).message}`);
        }
    }
}