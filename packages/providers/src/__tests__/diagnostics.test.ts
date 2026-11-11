import { describe, it, expect } from 'vitest';
import {
  BondingCurveTracker,
  WhaleTracker,
  SniperDetector,
} from '../pump-fun/analytics';
import {
  replayDerivedSignals,
  diagnoseStatsSources,
  DIAG_SNIPER_WINDOW_MS,
  DIAG_WHALE_SOL_THRESHOLD,
  type DiagnosticTradeInput,
  type RestMetaPresenceMap,
  type FieldSource,
} from '../pump-fun/diagnostics';

// ---------------------------------------------------------------------------
// Fixtures — fully local, no network / WebSocket / credentials
// ---------------------------------------------------------------------------

const MINT_A = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MINT_B = 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const WHALE = 'WhaleTrader1111111111111111111111111111';
const SMALL = 'SmallTrader22222222222222222222222222222';

const CREATED_AT = 1_000;

/** vTokens at exactly 25% bonding-curve progress (218_250_000 sold). */
const VTOKENS_25_PCT = 854_750_000;
/** vTokens at/under the graduation threshold (progress 1, graduated). */
const VTOKENS_GRADUATED = 200_000_000;

function trade(
  mint: string,
  trader: string,
  txType: 'buy' | 'sell',
  solAmount: number,
  timestamp: number,
  vTokens = VTOKENS_25_PCT,
  vSol = 30,
): DiagnosticTradeInput {
  return { mint, trader, txType, solAmount, timestamp, vTokensInBondingCurve: vTokens, vSolInBondingCurve: vSol };
}

const TRADES: DiagnosticTradeInput[] = [
  // Three windowed buys from the whale trader → confirmed sniper at hit #3.
  trade(MINT_A, WHALE, 'buy', 0.6, CREATED_AT + 500),
  trade(MINT_A, WHALE, 'buy', 0.5, CREATED_AT + 1_500),
  trade(MINT_A, WHALE, 'buy', 0.4, CREATED_AT + 2_500),
  // A sell still counts toward whale volume but never toward sniper score.
  trade(MINT_A, WHALE, 'sell', 0.5, CREATED_AT + 4_000),
  // Small trader buys outside the sniper window and pushes the curve to graduation.
  trade(MINT_A, SMALL, 'buy', 0.2, CREATED_AT + DIAG_SNIPER_WINDOW_MS + 1, VTOKENS_GRADUATED),
];

const CREATION_TIMES = { [MINT_A]: CREATED_AT };

// ---------------------------------------------------------------------------
// Entry 1: replay parity with the real analytics trackers
// ---------------------------------------------------------------------------

describe('replayDerivedSignals — parity with analytics trackers', () => {
  it('reproduces BondingCurveTracker / WhaleTracker / SniperDetector item by item', () => {
    // Reference implementation: drive the real trackers with the same inputs.
    const curve = new BondingCurveTracker();
    const whales = new WhaleTracker();
    const snipers = new SniperDetector();
    snipers.recordTokenCreation(MINT_A, CREATED_AT);

    const referenceHits: { trader: string; mint: string; delayMs: number; timestamp: number }[] = [];
    for (const t of TRADES) {
      if (t.vTokensInBondingCurve > 0) {
        curve.update(t.mint, t.vTokensInBondingCurve, t.vSolInBondingCurve);
      }
      whales.recordTrade(t.trader, t.solAmount, t.mint, t.timestamp);
      const hit = snipers.checkTrade(t.trader, t.mint, t.txType, t.timestamp);
      if (hit) referenceHits.push(hit);
    }

    const diag = replayDerivedSignals(TRADES, { tokenCreationTimes: CREATION_TIMES });

    // ---- bonding curve parity ----
    const refCurve = curve.get(MINT_A)!;
    const token = diag.tokens.find((x) => x.mint === MINT_A)!;
    expect(token).toBeDefined();
    // Final curve state equals the real tracker's last update (graduated trade).
    expect(token.bondingCurveProgress).toBe(refCurve.progress);
    expect(token.bondingCurveProgress).toBe(1);
    expect(token.graduated).toBe(refCurve.graduated);
    expect(token.graduated).toBe(true);
    expect(token.vTokens).toBe(refCurve.vTokens);
    expect(token.vSol).toBe(refCurve.vSol);
    expect(token.tradeCount).toBe(TRADES.length);

    // A replay stopped before the graduating trade must show exactly 25%.
    const beforeGraduation = replayDerivedSignals(TRADES.slice(0, 4), {
      tokenCreationTimes: CREATION_TIMES,
    });
    const quarterToken = beforeGraduation.tokens.find((x) => x.mint === MINT_A)!;
    expect(quarterToken.bondingCurveProgress).toBeCloseTo(0.25, 10);
    expect(quarterToken.graduated).toBe(false);

    // ---- whale parity ----
    const whaleTrader = diag.traders.find((x) => x.trader === WHALE)!;
    expect(whaleTrader.totalVolumeSol).toBeCloseTo(2.0, 10);
    expect(whaleTrader.isWhale).toBe(whales.isWhale(WHALE));
    expect(whaleTrader.isWhale).toBe(true);
    expect(diag.whaleTraders).toContain(WHALE);

    const smallTrader = diag.traders.find((x) => x.trader === SMALL)!;
    expect(smallTrader.totalVolumeSol).toBeCloseTo(0.2, 10);
    expect(smallTrader.isWhale).toBe(whales.isWhale(SMALL));
    expect(smallTrader.isWhale).toBe(false);
    expect(smallTrader.isWhale).toBe(0.2 >= DIAG_WHALE_SOL_THRESHOLD);
    expect(diag.whaleTraders).not.toContain(SMALL);

    // Per-token volume mirrors the global split for this single-mint fixture.
    expect(whaleTrader.perTokenVolumeSol[MINT_A]).toBeCloseTo(2.0, 10);
    const tokenWhale = token.traders.find((x) => x.trader === WHALE)!;
    expect(tokenWhale.volumeSol).toBeCloseTo(2.0, 10);
    expect(tokenWhale.isWhale).toBe(true);
    expect(tokenWhale.trades).toBe(4);
    const tokenSmall = token.traders.find((x) => x.trader === SMALL)!;
    expect(tokenSmall.volumeSol).toBeCloseTo(0.2, 10);
    expect(tokenSmall.isWhale).toBe(false);

    // ---- sniper parity ----
    expect(token.sniperHits).toHaveLength(referenceHits.length);
    expect(token.sniperHits).toHaveLength(3);
    expect(diag.sniperHits).toEqual(referenceHits);
    expect(token.sniperHits.map((h) => h.delayMs)).toEqual([500, 1_500, 2_500]);
    expect(diag.confirmedSnipers).toEqual([WHALE]);
    expect(snipers.isSniper(WHALE)).toBe(true);
    expect(snipers.isSniper(SMALL)).toBe(false);
    expect(diag.confirmedSnipers).not.toContain(SMALL);

    // The small trader's late buy must not appear as a hit anywhere.
    expect(diag.sniperHits.some((h) => h.trader === SMALL)).toBe(false);
  });

  it('does not confirm a sniper with fewer than 3 windowed buys', () => {
    const twoHits = [
      trade(MINT_B, SMALL, 'buy', 0.1, CREATED_AT + 100),
      trade(MINT_B, SMALL, 'buy', 0.1, CREATED_AT + 200),
    ];
    const diag = replayDerivedSignals(twoHits, { tokenCreationTimes: { [MINT_B]: CREATED_AT } });
    expect(diag.sniperHits).toHaveLength(2);
    expect(diag.confirmedSnipers).toEqual([]);
  });

  it('ignores sells for sniper scoring even inside the window', () => {
    const sells = [
      trade(MINT_B, WHALE, 'sell', 2, CREATED_AT + 100),
      trade(MINT_B, WHALE, 'sell', 2, CREATED_AT + 200),
      trade(MINT_B, WHALE, 'sell', 2, CREATED_AT + 300),
    ];
    const diag = replayDerivedSignals(sells, { tokenCreationTimes: { [MINT_B]: CREATED_AT } });
    expect(diag.sniperHits).toEqual([]);
    expect(diag.confirmedSnipers).toEqual([]);
    // Whale volume still accumulates from sells.
    expect(diag.traders[0].isWhale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Entry 2: stats snapshot provenance
// ---------------------------------------------------------------------------

describe('diagnoseStatsSources — REST override vs WS derivation', () => {
  function sourceOf(mintDiag: { fields: FieldSource[] }, fieldName: string): FieldSource {
    return mintDiag.fields.find((f) => f.field === fieldName)!;
  }

  it('marks bondingCurveProgress/graduated as WS-derived when REST does not provide them', () => {
    const snapshot = {
      topTokens: [
        {
          tokenAddress: MINT_A,
          symbol: 'AAA',
          name: 'Alpha',
          chain: 'solana',
          trades: 5,
          volume: 2.2,
          volumeSol: 2.2,
          nativeSymbol: 'SOL',
          source: 'pumpfun',
          bondingCurveProgress: 0.25,
          graduated: false,
        },
      ],
      traderEdges: [],
    };
    // Meta exists but carries neither bondingCurveProgress nor graduated.
    const presence: RestMetaPresenceMap = {
      [MINT_A]: { hasMeta: true, bondingCurveProgress: false, graduated: false, usdMarketCap: false },
    };

    const diag = diagnoseStatsSources(snapshot, presence);
    const tokenDiag = diag.tokens[0];
    expect(tokenDiag.mint).toBe(MINT_A);

    const progress = sourceOf(tokenDiag, 'bondingCurveProgress');
    expect(progress.source).toBe('ws');
    expect(progress.restOverridden).toBe(false);

    const graduated = sourceOf(tokenDiag, 'graduated');
    expect(graduated.source).toBe('ws');
    expect(graduated.restOverridden).toBe(false);

    // Plain metadata fields are still REST-overridden whenever meta exists.
    expect(sourceOf(tokenDiag, 'imageUrl').source).toBe('rest');
    expect(tokenDiag.restOverriddenFields).toContain('imageUrl');
    expect(tokenDiag.restOverriddenFields).not.toContain('bondingCurveProgress');
    expect(tokenDiag.wsDerivedFields).toContain('bondingCurveProgress');
    expect(tokenDiag.wsDerivedFields).toContain('graduated');
    expect(tokenDiag.wsDerivedFields).toContain('volume');
  });

  it('marks bondingCurveProgress/graduated/usdMarketCap/volumeUsd as REST when provided', () => {
    const snapshot = {
      topTokens: [
        {
          tokenAddress: MINT_A,
          symbol: 'AAA',
          name: 'Alpha',
          chain: 'solana',
          trades: 5,
          volume: 2.2,
          volumeSol: 2.2,
          nativeSymbol: 'SOL',
          source: 'pumpfun',
          bondingCurveProgress: 0.9,
          graduated: true,
          usdMarketCap: 50_000,
          volumeUsd: 50_000,
          imageUrl: 'https://example.com/a.png',
        },
      ],
      traderEdges: [
        {
          trader: WHALE,
          tokenAddress: MINT_A,
          chain: 'solana',
          trades: 4,
          volume: 2,
          volumeSol: 2,
          source: 'pumpfun',
          lastAction: 'sell' as const,
          isWhale: true,
          isSniper: true,
        },
      ],
    };
    const presence: RestMetaPresenceMap = {
      [MINT_A]: { hasMeta: true, bondingCurveProgress: true, graduated: true, usdMarketCap: true },
    };

    const diag = diagnoseStatsSources(snapshot, presence);
    const tokenDiag = diag.tokens[0];

    expect(sourceOf(tokenDiag, 'bondingCurveProgress').source).toBe('rest');
    expect(sourceOf(tokenDiag, 'bondingCurveProgress').restOverridden).toBe(true);
    expect(sourceOf(tokenDiag, 'graduated').source).toBe('rest');
    // usdMarketCap presence writes BOTH usdMarketCap and volumeUsd.
    expect(sourceOf(tokenDiag, 'usdMarketCap').source).toBe('rest');
    expect(sourceOf(tokenDiag, 'volumeUsd').source).toBe('rest');
    expect(sourceOf(tokenDiag, 'volumeUsd').reason).toMatch(/usdMarketCap/);
    expect(tokenDiag.restOverriddenFields).toEqual(
      expect.arrayContaining(['bondingCurveProgress', 'graduated', 'usdMarketCap', 'volumeUsd', 'imageUrl']),
    );
    expect(tokenDiag.restOverriddenFields).not.toContain('volume');

    // Trader-edge flags are always WS-derived from the analytics trackers.
    const edgeDiag = diag.traderEdges[0];
    expect(edgeDiag.trader).toBe(WHALE);
    expect(sourceOf(edgeDiag, 'isWhale').source).toBe('ws');
    expect(sourceOf(edgeDiag, 'isSniper').source).toBe('ws');
    expect(edgeDiag.restOverriddenFields).toEqual([]);
    expect(edgeDiag.wsDerivedFields).toEqual(expect.arrayContaining(['isWhale', 'isSniper', 'volume']));

    expect(diag.summary.tokenCount).toBe(1);
    expect(diag.summary.edgeCount).toBe(1);
    expect(diag.summary.restOverrideCount).toBeGreaterThan(0);
  });

  it('treats a snapshot without presence descriptor conservatively (conditional fields stay WS)', () => {
    const snapshot = {
      topTokens: [
        {
          tokenAddress: MINT_B,
          symbol: 'BBB',
          name: 'Beta',
          chain: 'solana',
          trades: 1,
          volume: 0.1,
          nativeSymbol: 'SOL',
          source: 'pumpfun',
          bondingCurveProgress: 0.1,
          graduated: false,
          imageUrl: 'https://example.com/b.png',
        },
      ],
      traderEdges: [],
    };
    const diag = diagnoseStatsSources(snapshot);
    const tokenDiag = diag.tokens[0];
    // REST-only field present in the snapshot lets us infer meta existed.
    expect(diag.warnings.some((w) => w.code === 'inferred-rest-meta')).toBe(true);
    expect(sourceOf(tokenDiag, 'imageUrl').source).toBe('rest');
    expect(sourceOf(tokenDiag, 'bondingCurveProgress').source).toBe('ws');
    expect(sourceOf(tokenDiag, 'graduated').source).toBe('ws');
  });
});

// ---------------------------------------------------------------------------
// Boundary inputs — never throw, no NaN, graceful degradation
// ---------------------------------------------------------------------------

describe('diagnostics boundary handling', () => {
  it('returns an empty replay for an empty trade list with a readable warning', () => {
    const diag = replayDerivedSignals([]);
    expect(diag.tokens).toEqual([]);
    expect(diag.traders).toEqual([]);
    expect(diag.sniperHits).toEqual([]);
    expect(diag.confirmedSnipers).toEqual([]);
    expect(diag.whaleTraders).toEqual([]);
    expect(diag.warnings[0]?.code).toBe('empty-input');
  });

  it('tolerates null / non-array input', () => {
    const diag = replayDerivedSignals(null);
    expect(diag.tokens).toEqual([]);
    expect(diag.warnings[0]?.code).toBe('invalid-input');
    // @ts-expect-error intentionally passing invalid runtime input
    expect(() => replayDerivedSignals('nope')).not.toThrow();
  });

  it('does not produce NaN and skips the curve update when vTokens is 0', () => {
    const diag = replayDerivedSignals([
      trade(MINT_A, WHALE, 'buy', 0.3, CREATED_AT + 100, 0, 0),
      trade(MINT_A, WHALE, 'buy', 0.3, CREATED_AT + 200, 0, 0),
    ], { tokenCreationTimes: { [MINT_A]: CREATED_AT } });

    const token = diag.tokens[0];
    expect(token.bondingCurveProgress).toBeNull();
    expect(token.graduated).toBeNull();
    expect(token.vTokens).toBeNull();
    expect(token.vSol).toBeNull();
    // No NaN anywhere in the serialized form.
    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain('NaN');
    expect(serialized).not.toContain('Infinity');
    expect(diag.warnings.some((w) => w.code === 'bonding-curve-skipped-zero-tokens')).toBe(true);
    // Sniper/whale logic still works without curve state.
    expect(diag.traders[0].totalVolumeSol).toBeCloseTo(0.6, 10);
    expect(diag.traders[0].isWhale).toBe(false);
    expect(diag.sniperHits).toHaveLength(2);
  });

  it('warns and degrades when creation time is missing or timestamp is earlier', () => {
    const missing = replayDerivedSignals([trade(MINT_A, WHALE, 'buy', 0.1, 500)]);
    expect(missing.sniperHits).toEqual([]);
    expect(missing.warnings.some((w) => w.code === 'sniper-skip-no-creation-time')).toBe(true);

    const early = replayDerivedSignals(
      [trade(MINT_A, WHALE, 'buy', 0.1, CREATED_AT - 10)],
      { tokenCreationTimes: { [MINT_A]: CREATED_AT } },
    );
    expect(early.sniperHits).toEqual([]);
    expect(early.warnings.some((w) => w.code === 'sniper-skip-negative-delay')).toBe(true);
    // Volume still accumulated; no throw, no NaN.
    expect(early.traders[0].totalVolumeSol).toBeCloseTo(0.1, 10);
  });

  it('skips malformed trades instead of throwing', () => {
    const mixed = [
      null,
      { trader: WHALE, txType: 'buy', solAmount: 0.1 }, // missing mint
      trade(MINT_A, WHALE, 'buy', 0.1, CREATED_AT + 10),
    ] as unknown as DiagnosticTradeInput[];
    const diag = replayDerivedSignals(mixed, { tokenCreationTimes: { [MINT_A]: CREATED_AT } });
    expect(diag.tokens).toHaveLength(1);
    expect(diag.tokens[0].tradeCount).toBe(1);
    expect(diag.warnings.some((w) => w.code === 'skip-non-object-trade')).toBe(true);
    expect(diag.warnings.some((w) => w.code === 'skip-trade-missing-mint')).toBe(true);
  });

  it('handles empty / malformed stats snapshots', () => {
    const diag = diagnoseStatsSources({ topTokens: [], traderEdges: [] });
    expect(diag.tokens).toEqual([]);
    expect(diag.traderEdges).toEqual([]);
    expect(diag.summary).toEqual({ tokenCount: 0, edgeCount: 0, restOverrideCount: 0, wsFieldCount: 0 });

    const loose = diagnoseStatsSources(undefined);
    expect(loose.tokens).toEqual([]);
    expect(loose.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// JSON-serializability guarantee (no Map / function / Promise / NaN)
// ---------------------------------------------------------------------------

describe('diagnostics are pure JSON-serializable data', () => {
  it('round-trips both diagnostics kinds through JSON.stringify/parse', () => {
    const replay = replayDerivedSignals(TRADES, { tokenCreationTimes: CREATION_TIMES });
    const replayJson = JSON.stringify(replay);
    expect(() => JSON.parse(replayJson)).not.toThrow();
    const replayBack = JSON.parse(replayJson);
    expect(replayBack).toEqual(replay);

    const stats = diagnoseStatsSources(
      {
        topTokens: [
          {
            tokenAddress: MINT_A,
            symbol: 'AAA',
            name: 'Alpha',
            chain: 'solana',
            trades: 5,
            volume: 2.2,
            nativeSymbol: 'SOL',
            source: 'pumpfun',
            bondingCurveProgress: 0.9,
            graduated: true,
            usdMarketCap: 50_000,
            volumeUsd: 50_000,
          },
        ],
        traderEdges: [
          { trader: WHALE, tokenAddress: MINT_A, chain: 'solana', trades: 4, volume: 2, isWhale: true, isSniper: true },
        ],
      },
      { [MINT_A]: { hasMeta: true, bondingCurveProgress: true, graduated: true, usdMarketCap: true } },
    );
    const statsJson = JSON.stringify(stats);
    expect(() => JSON.parse(statsJson)).not.toThrow();
    expect(JSON.parse(statsJson)).toEqual(stats);

    // Ensure no exotic runtime types leak into the output graph.
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      expect(node instanceof Map).toBe(false);
      expect(node instanceof Set).toBe(false);
      expect(node instanceof Promise).toBe(false);
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    };
    walk(replay);
    walk(stats);
  });
});
