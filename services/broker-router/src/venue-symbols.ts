export function isUsdCryptoSymbol(symbol: string): boolean {
  return /^[A-Z0-9]+-USD$/.test(symbol);
}

export function toAlpacaOrderSymbol(symbol: string): string {
  if (!isUsdCryptoSymbol(symbol)) {
    return symbol;
  }

  const base = symbol.slice(0, -4);
  return `${base}/USD`;
}

export function normalizeAlpacaSymbol(symbol: string): string {
  if (!symbol) {
    return symbol;
  }

  if (symbol.includes('/')) {
    return symbol.replace('/', '-').toUpperCase();
  }

  if (symbol.endsWith('USD') && !symbol.includes('-')) {
    return `${symbol.slice(0, -3)}-USD`.toUpperCase();
  }

  return symbol.toUpperCase();
}
