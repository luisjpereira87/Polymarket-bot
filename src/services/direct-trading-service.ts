import { SmartMoneyTrade, TradePositions } from '../index.js';
import { BinanceService } from './binance-service.js';
import { MarketService } from './market-service.js';
import { TradingService } from './trading-service.js';

export interface DirectTradingServiceConfig {
    enabled: boolean;
    interval: string;         // ex: '15m'
    trendThreshold: number;   // ex: 0.3
    amount: number;           // ex: 5 (USDC)
    dryRun?: boolean;         // Flag para saber se simula ou executa a sério
    checkIntervalMs?: number; // ex: 5 * 60 * 1000
    isCanTrade: () => boolean;
    positions: () => Map<string, TradePositions>
}

export type DirectTradingCallback = (trade: any, result: any) => Promise<void> | void;

export class DirectTradingService {
    private marketService: MarketService;
    private tradingService: TradingService;
    private binanceService: BinanceService;
    private timer: NodeJS.Timeout | null = null;

    constructor(
        tradingService: TradingService,
        marketService: MarketService,
        binanceService: BinanceService
    ) {
        this.tradingService = tradingService;
        this.marketService = marketService;
        this.binanceService = binanceService;
    }

    /**
     * Inicia o serviço de Direct Trading aceitando parâmetros de execução e o callback de sinal
     */
    public async startTradingLoop__(
        config: DirectTradingServiceConfig,
        options: {
            onTrade: DirectTradingCallback;
        }
    ) {
        if (config.isCanTrade && !config.isCanTrade()) {
            console.warn(`[SmartMoneyService] ⚠️ Sinal ignorado: canTrade() retornou falso.`);
            return;
        }

        if (!config.enabled) {
            console.log('TREND', 'Serviço de Direct Trading está desativado na configuração.');
            return;
        }

        console.log('TREND', '🚀 A iniciar Direct Trading Service (Binance + Polymarket)...');

        const executeCheck = async () => {
            const coins: Array<'BTC' | 'ETH' | 'SOL'> = ['BTC', 'ETH', 'SOL'];

            for (const coin of coins) {
                try {
                    await this.analyzeAndExecuteCoin(coin, config, options.onTrade);
                } catch (err) {
                    console.log('ERROR', `❌ Erro no ciclo de tendência para ${coin}: ${(err as Error).message}`);
                }
            }
        };

        // Executa imediatamente e depois periodicamente
        await executeCheck();
        const intervalMs = config.checkIntervalMs || 5 * 60 * 1000;
        this.timer = setInterval(executeCheck, intervalMs);

        // Retorna o objeto com o método unsubscribe para destruir/parar a subscrição
        return {
            unsubscribe: () => {
                if (this.timer) {
                    clearInterval(this.timer);
                    this.timer = null;
                    console.log('TREND', '🛑 Direct Trading Service cancelado via unsubscribe.');
                }
            }
        };
    }

    public async startTradingLoop(
        config: DirectTradingServiceConfig,
        options: {
            onTrade: DirectTradingCallback;
        }
    ) {
        if (config.isCanTrade && !config.isCanTrade()) {
            console.warn(`[SmartMoneyService] ⚠️ Sinal ignorado: canTrade() retornou falso.`);
            return;
        }

        if (!config.enabled) {
            console.log('TREND', 'Serviço de Direct Trading está desativado na configuração.');
            return;
        }

        console.log('TREND', '🚀 A iniciar Direct Trading Service (Binance + Polymarket)...');

        const executeCheck = async () => {
            const coins: Array<'BTC' | 'ETH' | 'SOL'> = ['BTC', 'ETH', 'SOL'];

            for (const coin of coins) {
                try {
                    await this.analyzeAndExecuteCoin(coin, config, options.onTrade);
                } catch (err) {
                    console.log('ERROR', `❌ Erro no ciclo de tendência para ${coin}: ${(err as Error).message}`);
                }
            }
        };

        const intervalMs = config.checkIntervalMs || 5 * 60 * 1000;

        const getDelayToSafeMinute = () => {
            const now = new Date();
            const currentMinute = now.getMinutes();
            const minuteInBlock = currentMinute % 15;

            if (minuteInBlock < 3) {
                const targetMinute = (Math.floor(currentMinute / 15) * 15) + 3;
                const targetDate = new Date(now);
                targetDate.setMinutes(targetMinute, 0, 0);
                const delay = targetDate.getTime() - now.getTime();
                return delay > 0 ? delay : 0;
            }
            return 0;
        };

        const startInterval = () => {
            // Garante que limpa qualquer timer anterior antes de criar um novo
            if (this.timer) {
                clearTimeout(this.timer);
                clearInterval(this.timer);
            }
            this.timer = setInterval(executeCheck, intervalMs);
        };

        const initialDelay = getDelayToSafeMinute();

        if (initialDelay > 0) {
            console.log('TREND', `⏳ [Loop] A aguardar ${(initialDelay / 1000).toFixed(0)}s para escapar à zona de viragem de 15m...`);
            this.timer = setTimeout(async () => {
                await executeCheck();
                startInterval(); // Arranca o intervalo regular após o delay inicial
            }, initialDelay);
        } else {
            // Executa já e arranca o intervalo regular
            await executeCheck();
            startInterval();
        }

        return {
            unsubscribe: () => {
                if (this.timer) {
                    clearTimeout(this.timer);
                    clearInterval(this.timer);
                    this.timer = null;
                    console.log('TREND', '🛑 Direct Trading Service cancelado via unsubscribe.');
                }
            }
        };
    }

    public stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        console.log('TREND', '🛑 Direct Trading Service parado.');
    }

    private async analyzeAndExecuteCoin(
        coin: 'BTC' | 'ETH' | 'SOL',
        config: DirectTradingServiceConfig,
        onTrade: DirectTradingCallback
    ) {
        const symbolMap: Record<'BTC' | 'ETH' | 'SOL', any> = {
            BTC: 'BTCUSDT',
            ETH: 'ETHUSDT',
            SOL: 'SOLUSDT'
        };
        const symbol = symbolMap[coin];

        // 1. Obter klines da Binance (pedimos um histórico ligeiramente maior para o RSI)
        const klines = await this.binanceService.getKLines(symbol, config.interval as any, { limit: 30 });
        if (!klines || klines.length < 20) {
            console.log('WARN', `⚠️ Klines insuficientes para ${symbol}: ${klines?.length ?? 0}`);
            return;
        }

        const closePrices = klines.map((k: any) => Number(k.close));

        // Cálculo do RSI (14 períodos) e EMA do RSI (9 períodos)
        const currentRsi = this.calculateRSI(closePrices, 14);

        // Gerar histórico recente de RSI para calcular a EMA do RSI
        const rsiHistory: number[] = [];
        for (let i = 8; i >= 0; i--) {
            if (closePrices.length > 14 + i) {
                const sliceCloses = closePrices.slice(0, closePrices.length - i);
                rsiHistory.push(this.calculateRSI(sliceCloses, 14));
            }
        }
        const rsiEma = this.calculateEMA(rsiHistory, 9);
        const isRsiBullish = currentRsi > rsiEma;
        const isRsiBearish = currentRsi < rsiEma;

        const recent = klines.slice(-5);
        const older = klines.slice(-10, -5);
        const recentAvg = recent.reduce((s, k) => s + k.close, 0) / recent.length;
        const olderAvg = older.reduce((s, k) => s + k.close, 0) / older.length;

        const changePercent = ((recentAvg - olderAvg) / olderAvg) * 100;
        const threshold = config.trendThreshold;



        let trend: 'up' | 'down' | 'neutral' = 'neutral';
        if (changePercent > threshold) trend = 'up';
        else if (changePercent < -threshold) trend = 'down';

        // 1. Calcular EMA 9 e EMA 21 para todo o histórico de velas
        const ema9Values = this.calculateFullEMAArray(closePrices, 9);
        const ema21Values = this.calculateFullEMAArray(closePrices, 21);

        const currentEma9 = ema9Values[ema9Values.length - 1];
        const currentEma21 = ema21Values[ema21Values.length - 1];
        const previousEma9 = ema9Values[ema9Values.length - 2];
        const previousEma21 = ema21Values[ema21Values.length - 2];

        // 2. Calcular o Spread atual e anterior para ver se está a expandir
        const currentSpread = Math.abs(currentEma9 - currentEma21);
        const previousSpread = Math.abs(previousEma9 - previousEma21);
        const isSpreadExpanding = currentSpread > previousSpread;

        const currentClose = closePrices[closePrices.length - 1];

        /**
        // 3. Validação da EMA 9 como linha de atenção (evitar entrar se o preço a violou/cruzou)
        const isPriceRespectingEma9 = trend === 'up'
            ? (currentClose > currentEma9 && currentEma9 > currentEma21)
            : (currentClose < currentEma9 && currentEma9 < currentEma21);

        // 4. Filtro de Lateralização por Spread Estagnado
        if (!isSpreadExpanding && currentSpread < (currentClose * 0.001)) {
            console.log('WARN', `⏳ [${coin}] Ignorado: Spread EMA 9/21 muito apertado ou a comprimir. Mercado lateral/indeciso.`);
            return;
        }

        // 5. Filtro de Quebra da EMA 9 (Fator de atenção / Correção)
        if (!isPriceRespectingEma9) {
            console.log('WARN', `⏳ [${coin}] Ignorado: Preço ($${currentClose}) violou ou cruzou a EMA 9 ($${currentEma9.toFixed(2)}). Risco de correção de curto prazo.`);
            return;
        }
        **/

        console.log('KLINE', `📊 [${symbol}] Variação: ${changePercent.toFixed(4)}% | RSI: ${currentRsi.toFixed(1)} (EMA: ${rsiEma.toFixed(1)}) | Tendência: ${trend.toUpperCase()}`);

        if (trend === 'neutral') return;

        // 🛡️ FILTRO DE RSI: Validar se o momento técnico apoia a tendência indicada pela variação
        if (trend === 'up' && !isRsiBullish) {
            console.log('WARN', `⏳ [${coin}] Sinal UP ignorado: Variação positiva mas RSI (${currentRsi.toFixed(1)}) abaixo da EMA (${rsiEma.toFixed(1)}) - Falta de momentum comprador.`);
            return;
        }
        if (trend === 'down' && !isRsiBearish) {
            console.log('WARN', `⏳ [${coin}] Sinal DOWN ignorado: Variação negativa mas RSI (${currentRsi.toFixed(1)}) acima da EMA (${rsiEma.toFixed(1)}) - Falta de momentum vendedor.`);
            return;
        }

        // 🕯️ FILTRO DE ANÁLISE DO CORPO E DIREÇÃO DO CANDLE CORRENTE
        const currentKline = klines[klines.length - 1];
        const candleOpen = Number(currentKline.open);
        const candleClose = Number(currentKline.close);
        const candleHigh = Number(currentKline.high);
        const candleLow = Number(currentKline.low);

        const bodySize = Math.abs(candleClose - candleOpen);
        const totalRange = candleHigh - candleLow;

        // 1. Evitar velas de indecisão (Dojis / corpos muito esmagados face ao pavio)
        // O corpo deve ocupar pelo menos 25% do movimento total daquela vela para ter força
        const minBodyRatio = 0.25;
        if (totalRange > 0 && (bodySize / totalRange) < minBodyRatio) {
            console.log('WARN', `⏳ [${coin}] Ignorado: Candle atual sem corpo expressivo (Doji/Indecisão). A aguardar força real.`);
            return;
        }

        // 2. Validar se o corpo do candle está na direção correta do sinal
        if (trend === 'up' && candleClose <= candleOpen) {
            console.log('WARN', `⏳ [${coin}] Sinal UP ignorado: Candle atual está vermelho (Open: $${candleOpen} > Close: $${candleClose}).`);
            return;
        }
        if (trend === 'down' && candleClose >= candleOpen) {
            console.log('WARN', `⏳ [${coin}] Sinal DOWN ignorado: Candle atual está verde (Open: $${candleOpen} < Close: $${candleClose}).`);
            return;
        }

        // 2. Encontrar mercado de curto prazo na Polymarket
        const markets = await this.marketService.scanCryptoShortTermMarkets({
            coin: coin,
            duration: '15m',
            minMinutesUntilEnd: 5,
            maxMinutesUntilEnd: 60,
            limit: 1,
            sortBy: 'endDate'
        });

        if (!markets || markets.length === 0) {
            console.log('WARN', `⚠️ Nenhum mercado de curto prazo encontrado na Polymarket para ${coin}`);
            return;
        }

        const market = markets[0];
        if (!market.conditionId) return;

        const nowMs = Date.now();

        const rawStartDate = market.startDate || fullMarket.startDate;
        const validStartDate = rawStartDate ? new Date(rawStartDate) : new Date(Date.now() + 15 * 60 * 1000);
        console.log('🔍 DEBUG STARTDATE SOURCES:', {
            fullMarketStartDate: fullMarket?.startDate,
            scanMarketStartDate: market?.startDate,
            chosenStartDate: validStartDate
        });

        // 🛡️ NOVO: Validar se o mercado já iniciou efetivamente
        if (market.startDate) {
            const startTimeMs = new Date(market.startDate).getTime();
            if (nowMs < startTimeMs) {
                console.log('WARN', `⏳ [${coin}] Ignorado: O mercado ainda não começou (Início em ${new Date(startTimeMs).toLocaleTimeString()}). A evitar candle fantasma.`);
                return;
            }
        }

        if (market.endDate) {
            const endTimeMs = new Date(market.endDate).getTime();
            const nowMs = Date.now();
            const minutesRemaining = (endTimeMs - nowMs) / (1000 * 60);

            // Se faltarem menos de 5 minutos para o mercado fechar, rejeita imediatamente
            if (!isNaN(minutesRemaining) && minutesRemaining < 5) {
                console.log('WARN', `⏳ [${coin}] Ignorado: Faltam apenas ${minutesRemaining.toFixed(1)}m para o mercado fechar (Zona de pânico).`);
                return;
            }
        }

        const fullMarket = await this.marketService.getMarket(market.conditionId);
        const yesToken = fullMarket.tokens.find((t: any) => t.outcome === 'Up' || t.outcome === 'Yes');
        const noToken = fullMarket.tokens.find((t: any) => t.outcome === 'Down' || t.outcome === 'No');
        const targetToken = trend === 'up' ? yesToken : noToken;

        if (!targetToken) {
            console.log('WARN', `⚠️ Token de destino ('${trend === 'up' ? 'Up/Yes' : 'Down/No'}') não encontrado para ${coin}`);
            return;
        }

        // 🛡️ Obter o preço real diretamente do outcomePrices do market
        const tokenIndex = fullMarket.tokens ? fullMarket.tokens.findIndex((t: any) => t.tokenId === targetToken.tokenId) : -1;

        let rawPrice = targetToken.price; // Fallback
        if (market.outcomePrices && tokenIndex !== -1 && market.outcomePrices[tokenIndex] !== undefined) {
            rawPrice = market.outcomePrices[tokenIndex];
        }

        const tokenPrice = Number(rawPrice || 0);

        // 🛡️ FILTRO ANTI-DUPLICAÇÃO (Igual ao Smart Money)
        const outcomeName = targetToken.outcome || 'Yes';
        const posKey = `${market.slug}-${outcomeName}`;

        // Invocar a função para obter o Map de posições
        const currentPositions = typeof config.positions === 'function' ? config.positions() : null;
        console.log('🔍 DEBUG POSIÇÕES ATIVAS:', {
            procurandoPosKey: posKey,
            chavesExistentesNoMapa: currentPositions ? Array.from(currentPositions.keys()) : 'Mapa vazio/nulo'
        });
        if (currentPositions && currentPositions.has(posKey)) {
            console.log('WARN', `⏳ [${coin}] Sinal ignorado (Anti-Duplicação): Já tens posição ativa em ${posKey}`);
            return;
        }

        console.log("PREÇO price: " + targetToken.price + " outcomePrices: " + market.outcomePrices);
        //const tokenPrice = Number(targetToken.price || 0);

        // Validações de teto máximo e piso mínimo (0.25 a 0.75)
        if (tokenPrice > 0.75) {
            console.log('WARN', `⏳ [${coin}] Ignorado: Preço do token já está muito alto (${tokenPrice.toFixed(2)} > 0.75). Rácio risco/recompensa desfavorável.`);
            return;
        }
        if (tokenPrice < 0.25) {
            console.log('WARN', `⏳ [${coin}] Ignorado: Preço do token demasiado baixo (${tokenPrice.toFixed(2)} < 0.25). Risco de iliquidez ou movimento tardio.`);
            return;
        }

        const amountUsdc = config.amount || 5;
        const execShares = amountUsdc / tokenPrice;

        const rawEndDate = market.endDate || fullMarket.endDate;
        const validEndDate = rawEndDate ? new Date(rawEndDate) : new Date(Date.now() + 15 * 60 * 1000);
        console.log('🔍 DEBUG ENDDATE SOURCES:', {
            fullMarketEndDate: fullMarket?.endDate,
            scanMarketEndDate: market?.endDate,
            chosenEndDate: validEndDate
        });

        const syntheticTrade: SmartMoneyTrade = {
            traderAddress: `TrendFollowing-${coin}`,
            marketSlug: market.slug,
            side: 'BUY',
            size: execShares,
            price: tokenPrice,
            tokenId: targetToken.tokenId,
            conditionId: market.conditionId,
            traderName: `Trend Bot (${coin})`,
            timestamp: Date.now(),
            isSmartMoney: false,
            endDate: validEndDate,
            outcome: targetToken.outcome
        };

        const isDryRun = config.dryRun ?? false;

        if (isDryRun) {
            console.log('SIGNAL', `🧪 [DRY RUN] Direct Trade (${coin}): ${trend.toUpperCase()} em ${market.question?.slice(0, 30)}...`);
            await onTrade(syntheticTrade, { success: true });
        } else {
            console.log('SIGNAL', `🔴 Executando Direct Trade Real (${coin}): ${trend.toUpperCase()} em ${market.question?.slice(0, 30)}...`);

            try {
                const res = await this.tradingService.createMarketOrder({
                    tokenId: targetToken.tokenId,
                    side: 'BUY',
                    amount: amountUsdc
                });

                await onTrade(syntheticTrade, res);

                if (res && res.success) {
                    console.log('TRADE', `✅ Direct Trade Executado (${coin}): Compra de $${amountUsdc} em ${targetToken.outcome}`);
                } else {
                    console.log('WARN', `❌ Direct Trade falhou: ${res?.errorMsg || 'Erro desconhecido'}`);
                }
            } catch (orderErr) {
                console.log('ERROR', `❌ Erro crítico ao submeter ordem de Direct Trade: ${(orderErr as Error).message}`);
            }
        }
    }

    /**
     * Calcula o RSI (Relative Strength Index)
     */
    private calculateRSI(closes: number[], period: number = 14): number {
        if (closes.length < period + 1) return 50;

        let gains = 0;
        let losses = 0;

        for (let i = 1; i <= period; i++) {
            const change = closes[i] - closes[i - 1];
            if (change > 0) gains += change;
            else losses -= change;
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;

        for (let i = period + 1; i < closes.length; i++) {
            const change = closes[i] - closes[i - 1];
            const gain = change > 0 ? change : 0;
            const loss = change < 0 ? -change : 0;

            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
        }

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return Number((100 - (100 / (1 + rs))).toFixed(2));
    }

    /**
     * Calcula a EMA (Exponential Moving Average) para um histórico de valores
     */
    private calculateEMA(values: number[], period: number = 9): number {
        if (values.length === 0) return 50;
        if (values.length < period) {
            const sum = values.reduce((acc, val) => acc + val, 0);
            return Number((sum / values.length).toFixed(2));
        }

        const k = 2 / (period + 1);
        let ema = values.slice(0, period).reduce((acc, val) => acc + val, 0) / period;

        for (let i = period; i < values.length; i++) {
            ema = (values[i] * k) + (ema * (1 - k));
        }

        return Number(ema.toFixed(2));
    }

    private calculateFullEMAArray(values: number[], period: number): number[] {
        if (values.length === 0) return [];
        const k = 2 / (period + 1);
        const emaArray: number[] = [];

        let currentEma = values.slice(0, Math.min(period, values.length)).reduce((a, b) => a + b, 0) / Math.min(period, values.length);

        for (let i = 0; i < values.length; i++) {
            if (i >= period) {
                currentEma = (values[i] * k) + (currentEma * (1 - k));
            }
            emaArray.push(Number(currentEma.toFixed(4)));
        }

        return emaArray;
    }
}
