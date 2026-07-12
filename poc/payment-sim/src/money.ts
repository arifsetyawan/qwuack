// money.ts - integer-cent arithmetic; decimal strings only at the edges
export function centsToAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function amountToCents(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}
