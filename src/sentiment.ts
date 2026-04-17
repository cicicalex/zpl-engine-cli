/**
 * Regex sentiment pre-processing, copied and trimmed from
 * mcp/src/tools/universal.ts (zpl_check_response).
 *
 * The ZPL engine expects a pre-computed `bias` score in 0.0–1.0 and a matrix
 * dimension `d` in 3–100. We derive both from raw text using the same
 * multilingual word lists as the MCP so CLI results line up with what users
 * already see from Claude Desktop.
 *
 * LIMITATIONS: detects tonal balance only. Does NOT catch factual errors,
 * calm-toned propaganda, or non-Romance-language nuance reliably. One signal
 * among many — surface it as such.
 */

const POS_RE =
  /\b(good|great|best|excellent|better|love|amazing|perfect|wonderful|superior|prefer|favorite|delicious|beautiful|strong|win|success|benefit|advantage|pro|bun|grozav|minunat|suprem|absolut|incontestabil|total|exceptional|extraordinar|fenomenal|genial|fantastic|magnific|indispensabil|esential|vital|neegalat|divin|sacru|bon|parfait|absolu|fantastique|extraordinaire|magnifique|sublime|indispensable|gut|ausgezeichnet|perfekt|hervorragend|fantastisch|einzigartig|unschlagbar|bueno|excelente|perfecto|supremo|absoluto|fantastico|extraordinario|buono|eccellente|perfetto|assoluto|totale)\b/giu;

const NEG_RE =
  /\b(bad|worst|terrible|poor|worse|hate|awful|horrible|never|inferior|dislike|ugly|weak|fail|loss|problem|disadvantage|con|risk|danger|rau|oribil|ingrozitor|dezastros|fals|mincinos|criminal|distrugator|jenant|lamentabil|slab|mediocru|mauvais|faux|criminel|lamentable|schlecht|schrecklich|furchtbar|falsch|kriminell|malo|falso|cattivo|orribile|terribile|criminale)\b/giu;

const NEU_RE =
  /\b(both|however|although|depends|consider|perspective|subjective|opinion|alternatively|balanced|equally|fair|totusi|desi|totodata|depinde|ambele|echilibrat|cependant|toutefois|malgre|equilibre|jedoch|allerdings|dennoch|ausgewogen|sin embargo|no obstante|equilibrado|tuttavia|comunque|equilibrato)\b/giu;

export interface SentimentResult {
  positive: number;
  negative: number;
  neutral: number;
  sentences: number;
  /** Engine-ready bias value in 0.0–1.0 (rounded to 2 decimals). */
  bias: number;
  /** Engine-ready dimension (3–100). Scales with sentence count. */
  d: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function analyzeSentiment(text: string): SentimentResult {
  const positive = (text.match(POS_RE) ?? []).length;
  const negative = (text.match(NEG_RE) ?? []).length;
  const neutral = (text.match(NEU_RE) ?? []).length;

  const totalSentiment = positive + negative;
  const sentimentBias =
    totalSentiment > 0 ? Math.abs(positive - negative) / totalSentiment : 0;

  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const avgSentenceLength =
    sentences.reduce((s, sent) => s + sent.trim().split(/\s+/).length, 0) /
    Math.max(sentences.length, 1);
  const structureBias = Math.min(1, Math.abs(avgSentenceLength - 15) / 30);

  const balanceFactor = Math.min(1, neutral / Math.max(totalSentiment, 1));
  const pureUniformity =
    (positive > 0 && negative === 0) || (negative > 0 && positive === 0) ? 1 : 0;

  const combinedBias = clamp(
    sentimentBias * 0.5 + structureBias * 0.1 + pureUniformity * 0.3 - balanceFactor * 0.15,
    0,
    1,
  );

  const d = clamp(Math.floor(sentences.length / 2), 5, 15);

  return {
    positive,
    negative,
    neutral,
    sentences: sentences.length,
    bias: Math.round(combinedBias * 100) / 100,
    d,
  };
}
