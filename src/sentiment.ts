/**
 * Regex sentiment pre-processing — text → engine-ready (d, bias) pair.
 *
 * v1.1.6 rewrite (fixes bug #4 "CLI bias inversion"):
 *
 *   Pre-fix problem
 *     The previous version emitted a `combinedBias` derived from sentiment
 *     imbalance, structure, and "pure uniformity," then passed that value
 *     directly to the engine as the matrix bias parameter. But the engine's
 *     AIN curve is FLAT in [0.1, 0.9] (always ~0.85–0.95) and only dips
 *     sharply at extremes (<0.05 or >0.95). So our nominally biased text
 *     (combinedBias 0.6–0.8) landed in the engine's "safe middle" and came
 *     back with HIGHLY_NEUTRAL — the opposite of what we promised on the
 *     box.
 *
 *     20-input brutal test (see /Dev/zpl-wizard-test/BRUTAL-CLI-TESTS.md):
 *     12 out of 15 non-edge inputs returned the inverted verdict. Sycophantic
 *     text scored AIN=99, balanced text scored AIN=0.
 *
 *   Post-fix model
 *     Step 1: compute `imbalance` ∈ [0, 1] from regex matches. 0 = no
 *             sentiment words OR balanced pos/neg counts. 1 = fully one-sided.
 *     Step 2: dampen `imbalance` by neutral-balance markers ("but", "however",
 *             "tradeoff", "weigh both", ...). Two such markers cuts imbalance
 *             in half — the writer is explicitly flagging balance even if
 *             vocab is one-sided.
 *     Step 3: map damped imbalance to engine bias using a quadratic squeeze:
 *               engineBias = 0.5 * (1 - imbalance)²
 *             so imbalance=0 → bias=0.5 (engine returns ~0.9 AIN, HIGH)
 *                imbalance=0.5 → bias=0.125 (engine returns ~0.75 AIN, MEDIUM)
 *                imbalance=1.0 → bias=0.0 → clamped to 0.01 (engine ~0.32, LOW)
 *
 *   Word lists expanded
 *     Added the most common English balance markers ("but", "however",
 *     "weakness", "strength", "tradeoff", "mixed", "uncertain", "depends",
 *     "weigh", "reasonable", "feasible", "caveat", "though", "while",
 *     "nevertheless", "achievable"). Multilingual entries preserved.
 *
 *   Limitations
 *     Still tone-only. Cannot detect calm-toned propaganda, factual errors,
 *     or sarcasm. Word lists are case-insensitive but not stem-aware, so
 *     "strengths" / "weakened" / "criminally" sometimes slip past. Treat
 *     AIN as ONE signal among many; pair with `zpl_sycophancy_score`
 *     (LLM-based) for semantic checks.
 */

const POS_RE =
  /\b(good|great|best|excellent|better|love|amazing|perfect|wonderful|superior|prefer|favorite|delicious|beautiful|strong|strength|strengths|win|success|benefit|advantage|pro|positive|brilliant|genius|outstanding|exceptional|stunning|magnificent|extraordinary|phenomenal|masterpiece|optimal|flawless|brilliantly|absolutely|definitely|certainly|incredible|bun|grozav|minunat|suprem|absolut|incontestabil|total|exceptional|extraordinar|fenomenal|genial|fantastic|magnific|indispensabil|esential|vital|neegalat|divin|sacru|bon|parfait|absolu|fantastique|extraordinaire|magnifique|sublime|indispensable|gut|ausgezeichnet|perfekt|hervorragend|fantastisch|einzigartig|unschlagbar|bueno|excelente|perfecto|supremo|absoluto|fantastico|extraordinario|buono|eccellente|perfetto|assoluto|totale)\b/giu;

const NEG_RE =
  /\b(bad|worst|terrible|poor|worse|hate|awful|horrible|never|inferior|dislike|ugly|weak|weakness|weaknesses|fail|loss|problem|disadvantage|con|risk|risks|danger|negative|disaster|catastrophic|pointless|hopeless|doomed|wasted|embarrassing|incompetent|reject|cancel|burn|broken|flawed|criminal|fraud|nonsense|garbage|junk|rau|oribil|ingrozitor|dezastros|fals|mincinos|criminal|distrugator|jenant|lamentabil|slab|mediocru|mauvais|faux|criminel|lamentable|schlecht|schrecklich|furchtbar|falsch|kriminell|malo|falso|cattivo|orribile|terribile|criminale)\b/giu;

const NEU_RE =
  /\b(both|however|but|though|although|while|nevertheless|nonetheless|tradeoff|tradeoffs|trade-off|caveat|caveats|mixed|reasonable|feasible|achievable|uncertain|depends|consider|consideration|perspective|alternative|alternatives|subjective|opinion|opinions|alternatively|balanced|equally|fair|weigh|review|review|reviews|reviewer|reviewers|scenario|scenarios|recommend|recommendation|recommendations|tradeoffsbalance|balance|totusi|desi|totodata|depinde|ambele|echilibrat|cependant|toutefois|malgre|equilibre|jedoch|allerdings|dennoch|ausgewogen|sin embargo|no obstante|equilibrado|tuttavia|comunque|equilibrato)\b/giu;

export interface SentimentResult {
  positive: number;
  negative: number;
  neutral: number;
  sentences: number;
  /** Engine-ready bias value in 0.0–1.0 (rounded to 2 decimals). */
  bias: number;
  /** Engine-ready dimension (3–100). Scales with sentence count. */
  d: number;
  /** Internal: pre-clamp imbalance score (0 = balanced/no sentiment, 1 = fully one-sided). For diagnostics. */
  imbalance: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Negation tokens ("no", "not", "never", "n't" contractions). When one of
// these sits within 3 words BEFORE a sentiment word, we flip its polarity.
// This catches "no risks" (false-negative without flip) and "not perfect"
// (false-positive without flip). Regex alone can't handle this; we run a
// scanning pass and rewrite the counts.
const NEGATION_RE =
  /\b(no|not|never|none|neither|nor|n't|cannot|isn't|aren't|wasn't|weren't|won't|wouldn't|don't|doesn't|didn't)\b/i;

function countWithNegation(text: string): { pos: number; neg: number } {
  // Split into sentences FIRST. Negation should never cross a sentence
  // boundary — "No upside whatsoever." in one sentence must not flip
  // "Catastrophic" in the next sentence (real regression seen during testing).
  const sentences = text.split(/[.!?]+/);
  let pos = 0;
  let neg = 0;

  for (const sentence of sentences) {
    const tokens = sentence.split(/\s+/).filter((t) => t.length > 0);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i].replace(/[^\p{L}'-]/giu, ""); // strip punctuation
      if (!tok) continue;
      const isPos = POS_RE.test(tok);
      POS_RE.lastIndex = 0; // reset global regex state
      const isNeg = NEG_RE.test(tok);
      NEG_RE.lastIndex = 0;
      if (!isPos && !isNeg) continue;
      // Look back up to 3 tokens in the SAME sentence for a negation.
      let negated = false;
      for (let j = Math.max(0, i - 3); j < i; j++) {
        if (NEGATION_RE.test(tokens[j])) {
          negated = true;
          break;
        }
      }
      if (isPos) {
        if (negated) neg++;
        else pos++;
      } else if (isNeg) {
        if (negated) pos++;
        else neg++;
      }
    }
  }
  return { pos, neg };
}

export function analyzeSentiment(text: string): SentimentResult {
  const neutral = (text.match(NEU_RE) ?? []).length;

  // Negation-aware tallies — flips "no risks" / "not perfect" / "never fail".
  // We DON'T use the raw POS_RE/NEG_RE counts here because they double-count
  // negated words (e.g. "no risks" would count "risks" as negative AND
  // countWithNegation would flip it, giving 2 contradictory tallies).
  const { pos: positive, neg: negative } = countWithNegation(text);

  const totalSentiment = positive + negative;

  // imbalance: 0 = balanced (or no sentiment found), 1 = fully one-sided.
  // When no sentiment words match, we default to 0 (i.e. treat factual /
  // neutral text as balanced, not as biased). This is the opposite of the
  // pre-fix behaviour where unmatched text fell through to bias≈0.05.
  let imbalance =
    totalSentiment > 0 ? Math.abs(positive - negative) / totalSentiment : 0;

  // Explicit balance markers ("but", "however", "weigh both") pull imbalance
  // toward 0. Two markers cut the imbalance in half; the rationale is that
  // a writer who hedges with multiple balance words is signalling balance
  // even when their vocab leans one-sided.
  const neutralDampener = Math.min(1, neutral / 2);
  imbalance = imbalance * (1 - neutralDampener * 0.5);

  // Map imbalance to engine bias param using a quadratic squeeze.
  //   imbalance=0   → engineBias=0.5    (engine returns AIN ~0.9, HIGH neutral)
  //   imbalance=0.5 → engineBias=0.125  (engine returns AIN ~0.75, MEDIUM)
  //   imbalance=1.0 → engineBias=0.0 → clamped to 0.01 (engine returns AIN ~0.32, LOW)
  // The quadratic is intentional: small imbalances should not move the
  // bias far from 0.5; only strong one-sidedness should push to extremes.
  const engineBias = clamp(0.5 * Math.pow(1 - imbalance, 2), 0.01, 0.5);

  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);

  // Matrix dimension scales with sentence count. Engine accepts 3..100;
  // we keep a tight 5..15 band for typical CLI inputs (≤ 30 sentences).
  const d = clamp(Math.floor(sentences.length / 2), 5, 15);

  return {
    positive,
    negative,
    neutral,
    sentences: sentences.length,
    bias: Math.round(engineBias * 100) / 100,
    d,
    imbalance: Math.round(imbalance * 100) / 100,
  };
}
