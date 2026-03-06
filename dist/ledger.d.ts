export interface LedgerEntry<TPayload = Record<string, unknown>> {
    id: string;
    context: string;
    currency: string;
    amount: string;
    payload?: TPayload;
}
export interface BalanceResult {
    total: string;
    byContext: Record<string, string>;
    entryCount: number;
}
export interface PaginatedResult<TPayload = Record<string, unknown>> {
    entries: LedgerEntry<TPayload>[];
    nextCursor: string;
    hasMore: boolean;
}
export interface LedgerConfig {
    maxEntriesPerKey?: number;
    keyPrefix?: string;
}
interface RequiredLedgerConfig {
    maxEntriesPerKey: number;
    keyPrefix: string;
}
export declare class Ledger<TPayload = Record<string, unknown>> {
    private adapter;
    private config;
    constructor(redis: unknown, config?: LedgerConfig);
    private getLedgerKey;
    private getTotalKey;
    private getContextKey;
    addEntry(accountId: string, currency: string, entry: LedgerEntry<TPayload>): Promise<void>;
    removeEntry(accountId: string, currency: string, entryId: string): Promise<boolean>;
    getEntry(accountId: string, currency: string, entryId: string): Promise<LedgerEntry<TPayload> | null>;
    getSum(accountId: string, currency: string): Promise<string>;
    getBalance(accountId: string, currency: string): Promise<BalanceResult>;
    getEntriesPaginated(accountId: string, currency: string, cursor?: string, count?: number): Promise<PaginatedResult<TPayload>>;
    clearLedger(accountId: string, currency: string): Promise<void>;
    getConfig(): RequiredLedgerConfig;
}
export default Ledger;
