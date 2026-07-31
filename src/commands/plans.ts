/**
 * `zpl plans` — list all ZPL plans with monthly token quota and price.
 *
 * v1.1.8 (audit 2026-05-13): switched to live fetch from engine
 * `/plans`. Pre-v1.1.8 the CLI shipped a hardcoded array with
 * token counts 5× larger than the engine actually enforces. A user
 * upgrading to Pro expecting 250K tokens (CLI claim) got 50K
 * (engine truth) and the difference looked like a billing bug. The
 * engine `/plans` endpoint is the single source of truth used by
 * MCP and both SDKs; the CLI is now consistent with them.
 *
 * AUDIT 2026-07-31: that live fetch never worked. It sent no Authorization
 * header and /plans requires one, so every call fell back and the note under
 * the table blamed an engine that was fine. Fixed, and the fallback is now
 * only what its name says: what to show when the engine genuinely cannot be
 * asked. The reason is named rather than guessed at.
 *
 * The claim below that the fallback carries "the SAME numbers the engine
 * returns" was also untrue by the time anyone checked - Agent listed 15 keys
 * against 50 on the website. test/plans-fallback.test.mjs pins it now.
 */
import chalk from "chalk";
import Table from "cli-table3";
import { TABLE_STYLE } from "../table-style.js";
import { USER_AGENT } from "../user-agent.js";
import { readConfig } from "../config.js";
import { validateEngineUrl } from "../engine-url-validate.js";

const DEFAULT_ENGINE_URL = "https://engine.zeropointlogic.io";

interface EnginePlan {
  name: string;
  tokens_per_month: number;
  price_usd: number;
  max_d: number;
  max_keys: number;
  unlimited?: boolean;
}

interface DisplayPlan extends EnginePlan {
  notes: string;
}

/**
 * Static fallback — used ONLY when the engine cannot be asked.
 * These numbers MUST match the website's PLAN_TIERS, which is what
 * actually issues keys and meters quota. Pinned by
 * test/plans-fallback.test.mjs, so drift fails the suite rather than
 * reaching a user through `--output json`.
 */
const FALLBACK_PLANS: DisplayPlan[] = [
  { name: "free", tokens_per_month: 5_000, price_usd: 0, max_d: 9, max_keys: 1, notes: "No card. Default after `zpl login`." },
  { name: "basic", tokens_per_month: 10_000, price_usd: 10, max_d: 16, max_keys: 1, notes: "Personal projects, light dev use." },
  { name: "pro", tokens_per_month: 50_000, price_usd: 29, max_d: 25, max_keys: 3, notes: "Solo developer, daily use." },
  { name: "gamepro", tokens_per_month: 150_000, price_usd: 69, max_d: 32, max_keys: 5, notes: "Game dev studios — loot / economy / matchmaking." },
  { name: "studio", tokens_per_month: 500_000, price_usd: 149, max_d: 48, max_keys: 10, notes: "Mid-size team, multiple projects." },
  { name: "agent", tokens_per_month: 2_000_000, price_usd: 199, max_d: 48, max_keys: 50, notes: "AI-agent workloads — high call volume." },
  { name: "enterprise", tokens_per_month: 10_000_000, price_usd: 499, max_d: 64, max_keys: 25, notes: "SLA + priority support." },
  { name: "enterprise_xl", tokens_per_month: 50_000_000, price_usd: 999, max_d: 100, max_keys: 50, notes: "Highest-volume tier, dedicated capacity." },
];

const NOTES_BY_NAME: Record<string, string> = Object.fromEntries(
  FALLBACK_PLANS.map((p) => [p.name, p.notes]),
);

export interface PlansOptions {
  output?: "text" | "json";
  baseUrl?: string;
}

/**
 * AUDIT 2026-07-31: this sent no Authorization header, and the engine's
 * /plans requires one - verified live, 401 "Missing Authorization header"
 * without a key and 200 with it. So `res.ok` was false on every call, the
 * function returned null every time, and the CLI has been showing its built-in
 * fallback since the live fetch was added in v1.1.8. Nobody has ever seen live
 * plan data from this command.
 *
 * The message under the table said "engine /plans unreachable", which sent
 * anyone investigating to look at the engine. The engine was fine.
 *
 * Returns the reason as well as the data so the caller can say which of the
 * three things happened - same distinction whoami and the compute route were
 * given today, for the same reason: "your key is missing" and "the server is
 * down" need different actions from the reader.
 */
type PlansFetch =
  | { plans: EnginePlan[]; reason: "live" }
  | { plans: null; reason: "no-key" | "rejected" | "unreachable" };

async function fetchEnginePlans(baseUrl: string, apiKey: string | null): Promise<PlansFetch> {
  if (!apiKey) return { plans: null, reason: "no-key" };
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/plans`, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { plans: null, reason: "rejected" };
    }
    if (!res.ok) return { plans: null, reason: "unreachable" };
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return { plans: null, reason: "unreachable" };
    const body = (await res.json()) as { plans?: EnginePlan[] };
    return Array.isArray(body.plans)
      ? { plans: body.plans, reason: "live" }
      : { plans: null, reason: "unreachable" };
  } catch {
    return { plans: null, reason: "unreachable" };
  }
}

export async function cmdPlans(opts: PlansOptions = {}): Promise<void> {
  const output = (opts.output ?? "text").toLowerCase();
  if (output !== "text" && output !== "json") {
    process.stderr.write(chalk.red(`Invalid --output: "${opts.output}". Must be text or json.\n`));
    process.exit(2);
  }

  // AUDIT 2026-07-31: this was `opts.baseUrl ?? "https://engine.zeropointlogic.io"`
  // and index.ts never passes baseUrl, so `zpl plans` was the one command that
  // ignored ZPL_ENGINE_URL and the configured engine.base_url. Anyone pointed
  // at a staging engine got production's plan list without being told.
  //
  // Routed through validateEngineUrl like every other path: this request now
  // carries the API key, so an unvalidated URL would send the key somewhere
  // the rest of the CLI would have refused. A rejected URL falls back to the
  // default rather than aborting, which is what config.ts does too - a bad
  // ZPL_ENGINE_URL should not brick a read-only command.
  const configuredUrl =
    process.env.ZPL_ENGINE_URL?.trim() || readConfig()?.engine?.base_url || null;
  let baseUrl = opts.baseUrl ?? DEFAULT_ENGINE_URL;
  if (!opts.baseUrl && configuredUrl) {
    try {
      baseUrl = validateEngineUrl(configuredUrl);
    } catch {
      process.stderr.write(
        chalk.yellow(`(ignoring unusable engine URL "${configuredUrl}" - using ${DEFAULT_ENGINE_URL})\n`),
      );
    }
  }
  // Soft read: `zpl plans` is useful before signing in, so a missing config is
  // not an error here - it only means the fallback is what gets shown, and the
  // note below says so instead of blaming the engine.
  const cfg = readConfig();
  const apiKey = process.env.ZPL_API_KEY?.trim() || cfg?.auth?.api_key || null;
  const result = await fetchEnginePlans(baseUrl, apiKey);
  const fetched = result.plans;

  const enriched: DisplayPlan[] = (fetched ?? FALLBACK_PLANS).map((p) => ({
    ...p,
    notes: NOTES_BY_NAME[p.name] ?? "",
  }));
  const source = fetched ? "engine_live" : "client_fallback";

  if (output === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          source,
          source_url: `${baseUrl}/plans`,
          currency: "USD",
          billing: "monthly",
          plans: enriched,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const table = new Table({
    head: [chalk.bold("Plan"), chalk.bold("Tokens/month"), chalk.bold("USD/month"), chalk.bold("Max d"), chalk.bold("Notes")],
    style: TABLE_STYLE,
    colWidths: [16, 16, 12, 8, 44],
    wordWrap: true,
  });
  for (const p of enriched) {
    const priceCell = p.price_usd === 0 ? chalk.green("Free") : `$${p.price_usd}`;
    table.push([p.name, p.tokens_per_month.toLocaleString(), priceCell, String(p.max_d), p.notes]);
  }
  process.stdout.write(table.toString() + "\n");
  if (source === "client_fallback") {
    const why =
      result.reason === "no-key"
        ? "not signed in, so the engine was not asked"
        : result.reason === "rejected"
          ? "the engine rejected this key"
          : "the engine could not be reached";
    process.stdout.write(
      chalk.yellow(`\n(showing built-in plan list - ${why}. Run \`zpl login\` for live figures.)\n`),
    );
  }
  process.stdout.write(
    chalk.gray(`\nUpgrade or change plan at ${chalk.cyan("https://zeropointlogic.io/pricing")}.\n`),
  );
}
