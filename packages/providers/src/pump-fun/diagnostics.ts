/**
 * Derived-signal diagnostics for the PumpFun provider.
 *
 * Pure, side-effect-free replay/inspection helpers that explain where the
 * provider's derived signals come from:
 *
 * 1. {@link replayDerivedSignals} — replays a batch of trade inputs through the
 *    exact same constants and rules as BondingCurveTracker, WhaleTracker and
 *    SniperDetector (see ./analytics.ts) without touching any WebSocket, REST
 *    client or global state.
 * 2. {@link diagnoseStatsSources} — given a getStats()-shaped snapshot of
 *    topTokens/traderEdges, annotates every field as REST-overridden or
 *    WS-derived, mirroring the assignment branches in
 *    PumpFunProvider.getStats().
 *
 * Everything returned by this module is plain JSON-serializable data: no
 * WebSocket, Map, Set, function, Promise or class instance ever appears in an
 * output object.
 */

// ---------------------------------------------------------------------------
// Constants — must stay identical to the ones in ./analytics.ts
// ---------------------------------------------------------------------------

/** BondingCurveTracker: initial virtual token reserves. */
export const DIAG_INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000;
/** BondingCurveTracker: virtual token reserves at/under which the token graduates. */
export const DIAG_GRADUATION_TOKEN_THRESHOLD = 200_000_000;
const GRADUATION_RANGE =
  DIAG_INITIAL_VIRTUAL_TOKEN_RESERVES - DIAG_GRADUATION_TOKEN_THRESHOLD;
/** WhaleTracker: cumulative SOL volume that flags a wallet as a whale. */
export const DIAG_WHALE_SOL_THRESHOLD = 1;
/** SniperDetector: only buys within this window after creation count. */
export const DIAG_SNIPER_WINDOW_MS = 3_000;
/** SniperDetector: number of windowed hits required to confirm a sniper. */
export const DIAG_SNIPER_CONFIRM_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Shared JSON-safety helpers
// ---------------------------------------------------------------------------

export interface DiagnosticWarning {
  /** Machine-readable code, e.g. 'empty-input'. */
  code: string;
  /** Human-readable explanation. */
  message: string;
  /** Index of the offending trade (replay warnings only, when applicable). */
  tradeIndex?: number;
  /** Mint the warning relates to, when applicable. */
  mint?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce arbitrary input to a finite number, mirroring getNumber(raw, key, 0). */
function finiteNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Reduce any snapshot value to something JSON.stringify can represent
 * faithfully (functions/symbols/bigint have no JSON form).
 */
function jsonSafeValue(value: unknown): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonSafeValue);
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafeValue(v);
    return out;
  }
  // function, symbol, bigint, undefined → no meaningful JSON representation
  return null;
}

// ---------------------------------------------------------------------------
// Entry 1: trade replay
// ---------------------------------------------------------------------------

/** One normalized trade input, shaped after PumpPortal trade messages. */
export interface DiagnosticTradeInput {
  mint: string;
  trader: string;
  /** 'buy' | 'sell' — only 'buy' is eligible for sniper detection. */
  txType: string;
  /** Trade size in SOL (already divided by 1e9, as in handleTrade). */
  solAmount: number;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  timestamp: number;
}

export interface ReplayOptions {
  /**
   * Optional token creation schedule: mint -> creation timestamp, mirroring
   * SniperDetector.recordTokenCreation. When absent for a mint, buys on that
   * mint cannot be sniper hits.
   */
  tokenCreationTimes?: Record<string, number>;
}

/** Per-trader state scoped to a single token. */
export interface ReplayTokenTrader {
  trader: string;
  /** Cumulative SOL volume of this trader on this token. */
  volumeSol: number;
  /** Number of trades by this trader on this token. */
  trades: number;
  /** Whale flag is global to the trader; repeated here for readability. */
  isWhale: boolean;
}

/** One sniper window hit, identical in shape to analytics.SniperHit. */
export interface ReplaySniperHit {
  trader: string;
  mint: string;
  delayMs: number;
  timestamp: number;
}

/** Replay output for one token. */
export interface ReplayTokenState {
  mint: string;
  /** Bonding-curve progress 0–1, or null when no positive vTokens observed. */
  bondingCurveProgress: number | null;
  /** True once vTokens <= 200_000_000; null until a curve update exists. */
  graduated: boolean | null;
  /** Last observed virtual token reserves, null when never updated. */
  vTokens: number | null;
  /** Last observed virtual SOL reserves, null when never updated. */
  vSol: number | null;
  /** Total number of valid trades replayed for this token. */
  tradeCount: number;
  traders: ReplayTokenTrader[];
  sniperHits: ReplaySniperHit[];
}

/** Global (cross-token) state for one trader. */
export interface ReplayTraderState {
  trader: string;
  /** Cumulative SOL volume across every token (WhaleTracker semantics). */
  totalVolumeSol: number;
  tradeCount: number;
  isWhale: boolean;
  /** Cumulative SOL volume broken down per mint. */
  perTokenVolumeSol: Record<string, number>;
}

export interface ReplayDiagnostics {
  kind: 'replay';
  tokens: ReplayTokenState[];
  traders: ReplayTraderState[];
  /** Every sniper hit across all tokens, in replay order. */
  sniperHits: ReplaySniperHit[];
  /** Traders whose cumulative windowed hits reached 3, in confirmation order. */
  confirmedSnipers: string[];
  /** Traders whose cumulative volume reached the whale threshold. */
  whaleTraders: string[];
  warnings: DiagnosticWarning[];
}

interface InternalTokenState {
  mint: string;
  progress: number | null;
  graduated: boolean | null;
  vTokens: number | null;
  vSol: number | null;
  tradeCount: number;
  /** trader -> per-token accumulator keyed by insertion order. */
  traders: Record<string, ReplayTokenTrader>;
  traderOrder: string[];
  sniperHits: ReplaySniperHit[];
}

interface InternalTraderState {
  trader: string;
  totalVolumeSol: number;
  tradeCount: number;
  isWhale: boolean;
  perTokenVolumeSol: Record<string, number>;
}

/**
 * Replay trade inputs through the same rules as the analytics trackers.
 *
 * Never throws on malformed input: invalid trades are skipped with a readable
 * warning and the result degrades gracefully.
 */
export function replayDerivedSignals(
  trades: readonly DiagnosticTradeInput[] | null | undefined,
  options: ReplayOptions = {},
): ReplayDiagnostics {
  const warnings: DiagnosticWarning[] = [];
  const tokens: Record<string, InternalTokenState> = {};
  const tokenOrder: string[] = [];
  const traders: Record<string, InternalTraderState> = {};
  const traderOrder: string[] = [];
  const sniperScores: Record<string, number> = {};
  const confirmedSnipers: string[] = [];
  const whaleTraders: string[] = [];
  const allHits: ReplaySniperHit[] = [];

  if (!Array.isArray(trades)) {
    warnings.push({
      code: 'invalid-input',
      message: 'trades input is not an array; returning an empty replay',
    });
    return finalizeReplay(tokens, tokenOrder, traders, traderOrder, allHits, confirmedSnipers, whaleTraders, warnings);
  }
  if (trades.length === 0) {
    warnings.push({
      code: 'empty-input',
      message: 'no trades were supplied; nothing to replay',
    });
    return finalizeReplay(tokens, tokenOrder, traders, traderOrder, allHits, confirmedSnipers, whaleTraders, warnings);
  }

  // Optional creation schedule — copied into a plain object, never mutated.
  const creationTimes: Record<string, number> = {};
  if (isPlainRecord(options.tokenCreationTimes)) {
    for (const [mint, ts] of Object.entries(options.tokenCreationTimes)) {
      if (Number.isFinite(ts)) creationTimes[mint] = ts;
    }
  }

  trades.forEach((rawTrade, index) => {
    if (!isPlainRecord(rawTrade)) {
      warnings.push({
        code: 'skip-non-object-trade',
        message: `trade at index ${index} is not an object; skipped`,
        tradeIndex: index,
      });
      return;
    }

    const mint = typeof rawTrade.mint === 'string' ? rawTrade.mint : '';
    if (!mint) {
      warnings.push({
        code: 'skip-trade-missing-mint',
        message: `trade at index ${index} has no mint; skipped`,
        tradeIndex: index,
      });
      return;
    }

    const trader = typeof rawTrade.trader === 'string' ? rawTrade.trader : '';
    const txType = typeof rawTrade.txType === 'string' ? rawTrade.txType : '';
    const solAmount = finiteNumber(rawTrade.solAmount, 0);
    if (!Number.isFinite(finiteNumber(rawTrade.solAmount, NaN))) {
      warnings.push({
        code: 'non-finite-sol-amount',
        message: `solAmount for trade ${index} on ${mint} was not finite; treated as 0`,
        tradeIndex: index,
        mint,
      });
    }
    const vTokens = finiteNumber(rawTrade.vTokensInBondingCurve, 0);
    const vSol = finiteNumber(rawTrade.vSolInBondingCurve, 0);
    const timestamp = finiteNumber(rawTrade.timestamp, 0);

    // --- token accumulator (insertion-ordered) ---
    let token = tokens[mint];
    if (!token) {
      token = {
        mint,
        progress: null,
        graduated: null,
        vTokens: null,
        vSol: null,
        tradeCount: 0,
        traders: {},
        traderOrder: [],
        sniperHits: [],
      };
      tokens[mint] = token;
      tokenOrder.push(mint);
    }
    token.tradeCount++;

    // --- whale/volume accumulation (every trade, buy or sell) ---
    let tokenTrader = token.traders[trader];
    if (!tokenTrader) {
      tokenTrader = { trader, volumeSol: 0, trades: 0, isWhale: false };
      token.traders[trader] = tokenTrader;
      token.traderOrder.push(trader);
    }
    tokenTrader.volumeSol += solAmount;
    tokenTrader.trades++;

    let globalTrader = traders[trader];
    if (!globalTrader) {
      globalTrader = {
        trader,
        totalVolumeSol: 0,
        tradeCount: 0,
        isWhale: false,
        perTokenVolumeSol: {},
      };
      traders[trader] = globalTrader;
      traderOrder.push(trader);
    }
    globalTrader.totalVolumeSol += solAmount;
    globalTrader.tradeCount++;
    globalTrader.perTokenVolumeSol[mint] =
      (globalTrader.perTokenVolumeSol[mint] ?? 0) + solAmount;
    const wasWhale = globalTrader.isWhale;
    globalTrader.isWhale = globalTrader.totalVolumeSol >= DIAG_WHALE_SOL_THRESHOLD;
    if (globalTrader.isWhale && !wasWhale) whaleTraders.push(trader);
    tokenTrader.isWhale = globalTrader.isWhale;

    // --- bonding curve (handleTrade only updates when vTokens > 0) ---
    if (vTokens > 0) {
      const tokensSold = DIAG_INITIAL_VIRTUAL_TOKEN_RESERVES - vTokens;
      const progress = Math.max(0, Math.min(1, tokensSold / GRADUATION_RANGE));
      const graduated = vTokens <= DIAG_GRADUATION_TOKEN_THRESHOLD;
      token.progress = progress;
      token.graduated = graduated;
      token.vTokens = vTokens;
      token.vSol = vSol;
    } else {
      warnings.push({
        code: 'bonding-curve-skipped-zero-tokens',
        message: `vTokensInBondingCurve for trade ${index} on ${mint} is 0; bonding curve not updated`,
        tradeIndex: index,
        mint,
      });
    }

    // --- sniper detection (buys only, creation time required, windowed) ---
    if (txType !== 'buy') return;
    const createdAt = creationTimes[mint];
    if (createdAt === undefined) {
      warnings.push({
        code: 'sniper-skip-no-creation-time',
        message: `no creation time recorded for ${mint}; buy at index ${index} cannot be evaluated`,
        tradeIndex: index,
        mint,
      });
      return;
    }
    const delayMs = timestamp - createdAt;
    if (delayMs < 0) {
      warnings.push({
        code: 'sniper-skip-negative-delay',
        message: `buy at index ${index} on ${mint} predates token creation by ${-delayMs}ms; ignored`,
        tradeIndex: index,
        mint,
      });
      return;
    }
    if (delayMs > DIAG_SNIPER_WINDOW_MS) return;

    const hit: ReplaySniperHit = { trader, mint, delayMs, timestamp };
    token.sniperHits.push(hit);
    allHits.push(hit);
    const score = (sniperScores[trader] ?? 0) + 1;
    sniperScores[trader] = score;
    if (score >= DIAG_SNIPER_CONFIRM_THRESHOLD && !confirmedSnipers.includes(trader)) {
      confirmedSnipers.push(trader);
    }
  });

  return finalizeReplay(tokens, tokenOrder, traders, traderOrder, allHits, confirmedSnipers, whaleTraders, warnings);
}

function finalizeReplay(
  tokens: Record<string, InternalTokenState>,
  tokenOrder: string[],
  traders: Record<string, InternalTraderState>,
  traderOrder: string[],
  allHits: ReplaySniperHit[],
  confirmedSnipers: string[],
  whaleTraders: string[],
  warnings: DiagnosticWarning[],
): ReplayDiagnostics {
  const tokenStates: ReplayTokenState[] = tokenOrder.map((mint) => {
    const t = tokens[mint];
    return {
      mint: t.mint,
      bondingCurveProgress: t.progress,
      graduated: t.graduated,
      vTokens: t.vTokens,
      vSol: t.vSol,
      tradeCount: t.tradeCount,
      traders: t.traderOrder.map((addr) => ({ ...t.traders[addr] })),
      sniperHits: t.sniperHits.map((h) => ({ ...h })),
    };
  });

  const traderStates: ReplayTraderState[] = traderOrder.map((addr) => {
    const tr = traders[addr];
    return {
      trader: tr.trader,
      totalVolumeSol: tr.totalVolumeSol,
      tradeCount: tr.tradeCount,
      isWhale: tr.isWhale,
      perTokenVolumeSol: { ...tr.perTokenVolumeSol },
    };
  });

  return {
    kind: 'replay',
    tokens: tokenStates,
    traders: traderStates,
    sniperHits: allHits.map((h) => ({ ...h })),
    confirmedSnipers: [...confirmedSnipers],
    whaleTraders: [...whaleTraders],
    warnings: warnings.map((w) => ({ ...w })),
  };
}

// ---------------------------------------------------------------------------
// Entry 2: getStats snapshot field-provenance diagnostics
// ---------------------------------------------------------------------------

/**
 * Presence descriptor of the REST metadata that getStats() saw for a mint.
 * getStats itself only keeps the post-merge snapshot, so callers that need
 * exact provenance for the conditional fields pass this plain object.
 */
export interface RestTokenMetaPresence {
  /** true when metadataEnricher.get(mint) returned a defined meta object. */
  hasMeta: boolean;
  /** meta.bondingCurveProgress !== undefined (only then is the field overridden). */
  bondingCurveProgress?: boolean;
  /** meta.graduated !== undefined (only then is the field overridden). */
  graduated?: boolean;
  /** !!meta.usdMarketCap (truthy value also writes volumeUsd). */
  usdMarketCap?: boolean;
  /**
   * Presence overrides for individual plain metadata fields. Defaults to
   * hasMeta for every field getStats assigns unconditionally.
   */
  fields?: Record<string, boolean>;
}

/** mint -> REST metadata presence. */
export type RestMetaPresenceMap = Record<string, RestTokenMetaPresence>;

/** A getStats()-shaped snapshot (only topTokens/traderEdges are inspected). */
export interface StatsSnapshotInput {
  topTokens?: unknown;
  traderEdges?: unknown;
}

export type SignalSource = 'rest' | 'ws' | 'none';

export interface FieldSource {
  field: string;
  source: SignalSource;
  /** true exactly when getStats assigns this field from REST metadata. */
  restOverridden: boolean;
  reason: string;
  /** JSON-safe copy of the snapshot value (null when not JSON-representable). */
  value: unknown;
}

export interface TokenSourceDiagnostic {
  mint: string;
  fields: FieldSource[];
  restOverriddenFields: string[];
  wsDerivedFields: string[];
}

export interface EdgeSourceDiagnostic {
  trader: string;
  mint: string;
  fields: FieldSource[];
  restOverriddenFields: string[];
  wsDerivedFields: string[];
}

export interface StatsSourceDiagnostics {
  kind: 'stats-sources';
  tokens: TokenSourceDiagnostic[];
  traderEdges: EdgeSourceDiagnostic[];
  summary: {
    tokenCount: number;
    edgeCount: number;
    restOverrideCount: number;
    wsFieldCount: number;
  };
  warnings: DiagnosticWarning[];
}

/**
 * Fields getStats assigns unconditionally from meta when a meta object exists
 * (see PumpFunProvider.getStats). None of these are ever WS-derived.
 */
const PLAIN_REST_FIELDS = [
  'imageUrl',
  'description',
  'twitter',
  'telegram',
  'website',
  'creator',
  'createdTimestamp',
  'replyCount',
  'kingOfTheHillTimestamp',
  'raydiumPool',
  'totalSupply',
  'nsfw',
] as const;

/** Fields accumulated from WS trade messages in handleTrade/handleTokenCreate. */
const WS_TOKEN_FIELDS = [
  'tokenAddress',
  'mint',
  'symbol',
  'name',
  'chain',
  'trades',
  'volume',
  'volumeSol',
  'nativeSymbol',
  'source',
] as const;

const WS_EDGE_FIELDS = [
  'trader',
  'tokenAddress',
  'mint',
  'chain',
  'trades',
  'volume',
  'volumeSol',
  'source',
  'lastAction',
] as const;

function field(
  name: string,
  source: SignalSource,
  reason: string,
  rawValue: unknown,
): FieldSource {
  return {
    field: name,
    source,
    restOverridden: source === 'rest',
    reason,
    value: jsonSafeValue(rawValue),
  };
}

/**
 * Annotate every field of a getStats()-shaped topTokens/traderEdges snapshot
 * with its provenance ('rest' | 'ws' | 'none').
 *
 * The branch logic mirrors PumpFunProvider.getStats exactly:
 * - plain metadata fields are REST-assigned whenever meta exists;
 * - bondingCurveProgress/graduated are REST-overridden only when meta provides
 *   them, otherwise they remain WS-derived (or absent);
 * - usdMarketCap and volumeUsd are REST-written together only when
 *   meta.usdMarketCap is truthy.
 */
export function diagnoseStatsSources(
  snapshot: StatsSnapshotInput | null | undefined,
  restMetaPresence: RestMetaPresenceMap | null | undefined = null,
): StatsSourceDiagnostics {
  const warnings: DiagnosticWarning[] = [];
  const presence = isPlainRecord(restMetaPresence) ? restMetaPresence : {};

  const topTokens = Array.isArray(snapshot?.topTokens) ? snapshot!.topTokens : [];
  const traderEdges = Array.isArray(snapshot?.traderEdges) ? snapshot!.traderEdges : [];
  if (!Array.isArray(snapshot?.topTokens)) {
    warnings.push({
      code: 'missing-top-tokens',
      message: 'snapshot.topTokens is not an array; token provenance will be empty',
    });
  }
  if (!Array.isArray(snapshot?.traderEdges)) {
    warnings.push({
      code: 'missing-trader-edges',
      message: 'snapshot.traderEdges is not an array; edge provenance will be empty',
    });
  }

  let restOverrideCount = 0;
  let wsFieldCount = 0;

  const tokenDiagnostics: TokenSourceDiagnostic[] = topTokens.map((rawToken, i) => {
    if (!isPlainRecord(rawToken)) {
      warnings.push({
        code: 'skip-non-object-token',
        message: `topTokens[${i}] is not an object; skipped`,
      });
      return { mint: '', fields: [], restOverriddenFields: [], wsDerivedFields: [] };
    }
    const token = rawToken;
    const mint = typeof token.tokenAddress === 'string' ? token.tokenAddress : '';
    const descriptor = isPlainRecord(presence[mint])
      ? (presence[mint] as RestTokenMetaPresence)
      : undefined;

    // Without an explicit descriptor, infer hasMeta from REST-only fields that
    // WS accumulation can never populate; conditional fields stay conservative.
    const inferredMeta = PLAIN_REST_FIELDS.some(
      (f) => token[f] !== undefined && token[f] !== null,
    ) || token.usdMarketCap !== undefined;
    const hasMeta = descriptor ? descriptor.hasMeta === true : inferredMeta;
    if (!descriptor && inferredMeta) {
      warnings.push({
        code: 'inferred-rest-meta',
        message: `no REST presence descriptor for ${mint}; meta presence inferred from snapshot fields`,
        mint,
      });
    }

    const fields: FieldSource[] = [];

    // WS accumulator fields
    for (const f of WS_TOKEN_FIELDS) {
      const src: SignalSource = token[f] === undefined ? 'none' : 'ws';
      if (src === 'ws') wsFieldCount++;
      fields.push(
        field(
          f,
          src,
          src === 'ws'
            ? 'accumulated from PumpPortal WS trade/tokenCreate messages'
            : 'absent from snapshot',
          token[f],
        ),
      );
    }

    // Plain REST metadata fields (unconditional assignment when meta exists)
    for (const f of PLAIN_REST_FIELDS) {
      const fieldPresent = descriptor?.fields?.[f] ?? hasMeta;
      if (fieldPresent) {
        restOverrideCount++;
        fields.push(field(f, 'rest', 'assigned from REST metadata in getStats()', token[f]));
      } else {
        fields.push(
          field(f, 'none', 'no REST metadata available; getStats() did not touch this field', token[f]),
        );
      }
    }

    // bondingCurveProgress: REST only when meta explicitly provides it
    const progressRest = hasMeta && descriptor?.bondingCurveProgress === true;
    if (progressRest) {
      restOverrideCount++;
      fields.push(
        field(
          'bondingCurveProgress',
          'rest',
          'meta.bondingCurveProgress was defined; REST value overrides WS bonding-curve progress',
          token.bondingCurveProgress,
        ),
      );
    } else if (token.bondingCurveProgress !== undefined) {
      wsFieldCount++;
      fields.push(
        field(
          'bondingCurveProgress',
          'ws',
          descriptor
            ? 'REST metadata did not provide bondingCurveProgress; WS BondingCurveTracker value retained'
            : 'no REST presence descriptor; treated as WS-derived bonding-curve progress',
          token.bondingCurveProgress,
        ),
      );
    } else {
      fields.push(
        field('bondingCurveProgress', 'none', 'absent: no REST override and no WS curve state', undefined),
      );
    }

    // graduated: REST only when meta explicitly provides it
    const graduatedRest = hasMeta && descriptor?.graduated === true;
    if (graduatedRest) {
      restOverrideCount++;
      fields.push(
        field(
          'graduated',
          'rest',
          'meta.graduated was defined; REST value overrides WS graduation flag',
          token.graduated,
        ),
      );
    } else if (token.graduated !== undefined) {
      wsFieldCount++;
      fields.push(
        field(
          'graduated',
          'ws',
          descriptor
            ? 'REST metadata did not provide graduated; WS BondingCurveTracker value retained'
            : 'no REST presence descriptor; treated as WS-derived graduation flag',
          token.graduated,
        ),
      );
    } else {
      fields.push(field('graduated', 'none', 'absent: no REST override and no WS curve state', undefined));
    }

    // usdMarketCap + volumeUsd: written together only when meta.usdMarketCap truthy
    const usdRest = hasMeta && descriptor?.usdMarketCap === true;
    if (usdRest) {
      restOverrideCount += 2;
      fields.push(
        field('usdMarketCap', 'rest', 'meta.usdMarketCap was truthy; assigned from REST metadata', token.usdMarketCap),
      );
      fields.push(
        field('volumeUsd', 'rest', 'getStats() writes volumeUsd = meta.usdMarketCap in the same branch', token.volumeUsd),
      );
    } else {
      fields.push(
        field('usdMarketCap', 'none', 'only written from REST usdMarketCap, which was not provided', token.usdMarketCap),
      );
      if (token.volumeUsd !== undefined) {
        wsFieldCount++;
        fields.push(
          field(
            'volumeUsd',
            'ws',
            'present in snapshot but no REST usdMarketCap branch fired; pre-existing WS/accumulator value retained',
            token.volumeUsd,
          ),
        );
      } else {
        fields.push(field('volumeUsd', 'none', 'absent: REST usdMarketCap branch did not fire', undefined));
      }
    }

    const restOverriddenFields = fields.filter((f) => f.restOverridden).map((f) => f.field);
    const wsDerivedFields = fields.filter((f) => f.source === 'ws').map((f) => f.field);
    return { mint, fields, restOverriddenFields, wsDerivedFields };
  }).filter((d) => d.mint !== '');

  const edgeDiagnostics: EdgeSourceDiagnostic[] = traderEdges.map((rawEdge, i) => {
    if (!isPlainRecord(rawEdge)) {
      warnings.push({
        code: 'skip-non-object-edge',
        message: `traderEdges[${i}] is not an object; skipped`,
      });
      return { trader: '', mint: '', fields: [], restOverriddenFields: [], wsDerivedFields: [] };
    }
    const edge = rawEdge;
    const fields: FieldSource[] = [];
    for (const f of WS_EDGE_FIELDS) {
      const src: SignalSource = edge[f] === undefined ? 'none' : 'ws';
      if (src === 'ws') wsFieldCount++;
      fields.push(
        field(
          f,
          src,
          src === 'ws' ? 'accumulated from PumpPortal WS trade messages' : 'absent from snapshot',
          edge[f],
        ),
      );
    }
    // Whale/sniper flags come from the WS analytics trackers in getStats().
    const flagSource = (name: string, tracker: string): void => {
      if (edge[name] === undefined) {
        fields.push(field(name, 'none', 'absent from snapshot', undefined));
        return;
      }
      wsFieldCount++;
      fields.push(
        field(name, 'ws', `annotated by ${tracker} during getStats() (WS-derived)`, edge[name]),
      );
    };
    flagSource('isWhale', 'WhaleTracker');
    flagSource('isSniper', 'SniperDetector');

    const restOverriddenFields = fields.filter((f) => f.restOverridden).map((f) => f.field);
    const wsDerivedFields = fields.filter((f) => f.source === 'ws').map((f) => f.field);
    return {
      trader: typeof edge.trader === 'string' ? edge.trader : '',
      mint: typeof edge.tokenAddress === 'string' ? edge.tokenAddress : '',
      fields,
      restOverriddenFields,
      wsDerivedFields,
    };
  }).filter((d) => d.trader !== '' || d.mint !== '');

  return {
    kind: 'stats-sources',
    tokens: tokenDiagnostics,
    traderEdges: edgeDiagnostics,
    summary: {
      tokenCount: tokenDiagnostics.length,
      edgeCount: edgeDiagnostics.length,
      restOverrideCount,
      wsFieldCount,
    },
    warnings: warnings.map((w) => ({ ...w })),
  };
}
