export interface OrderBookValidationResult {
    isValid: boolean;
    averageExecutionPrice: number;
    maxPriceTouched: number;
    totalShares: number;
    reason?: string;
}

export class OrderbookService {
    private cache: Map<string, { data: any; timestamp: number }> = new Map();
    private cacheTtlMs: number;

    constructor(cacheTtlMs = 500) {
        this.cacheTtlMs = cacheTtlMs;
    }

    /**
     * Valida o slippage e a profundidade do orderbook simulando o preenchimento de uma ordem pelo tamanho (USDC)
     */
    async validateOrderBookSlippage(
        tokenId: string,
        amountUsdc: number,
        maxAllowedPrice: number = 0.75,
        minAllowedPrice: number = 0.25
    ): Promise<OrderBookValidationResult> {
        try {
            // Podes usar fetch direto ou o método correspondente da SDK se disponível
            const response = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
            if (!response.ok) {
                return { isValid: false, averageExecutionPrice: 0, maxPriceTouched: 0, totalShares: 0, reason: 'Erro ao contactar a API do CLOB' };
            }

            const bookData = (await response.json()) as any;

            if (!bookData || !bookData.asks || bookData.asks.length === 0) {
                return { isValid: false, averageExecutionPrice: 0, maxPriceTouched: 0, totalShares: 0, reason: 'Livro de ordens sem asks disponíveis' };
            }

            let remainingUsdc = amountUsdc;
            let totalShares = 0;
            let maxPriceTouched = 0;

            // Ordenar os asks por preço ascendente
            const sortedAsks = [...bookData.asks].sort((a: any, b: any) => Number(a.price) - Number(b.price));

            for (const ask of sortedAsks) {
                const askPrice = Number(ask.price);
                const askSize = Number(ask.size);
                const costAtThisLevel = askPrice * askSize;

                if (remainingUsdc <= costAtThisLevel) {
                    const sharesNeeded = remainingUsdc / askPrice;
                    totalShares += sharesNeeded;
                    maxPriceTouched = Math.max(maxPriceTouched, askPrice);
                    remainingUsdc = 0;
                    break;
                } else {
                    remainingUsdc -= costAtThisLevel;
                    totalShares += askSize;
                    maxPriceTouched = Math.max(maxPriceTouched, askPrice);
                }
            }

            if (remainingUsdc > 0) {
                return { isValid: false, averageExecutionPrice: 0, maxPriceTouched, totalShares, reason: `Liquidez insuficiente no livro para preencher os $${amountUsdc}` };
            }

            const averageExecutionPrice = amountUsdc / totalShares;

            if (maxPriceTouched > maxAllowedPrice) {
                return { isValid: false, averageExecutionPrice, maxPriceTouched, totalShares, reason: `Pior preço necessário no livro (${maxPriceTouched.toFixed(2)}) excede o teto de ${maxAllowedPrice}` };
            }

            if (averageExecutionPrice < minAllowedPrice) {
                return { isValid: false, averageExecutionPrice, maxPriceTouched, totalShares, reason: `Preço médio (${averageExecutionPrice.toFixed(2)}) abaixo do piso de ${minAllowedPrice}` };
            }

            return {
                isValid: true,
                averageExecutionPrice,
                maxPriceTouched,
                totalShares
            };

        } catch (error) {
            return { isValid: false, averageExecutionPrice: 0, maxPriceTouched: 0, totalShares: 0, reason: `Exceção ao validar order book: ${(error as Error).message}` };
        }
    }
}