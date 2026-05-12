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
 * Fallback: if the engine is unreachable, render a tight static
 * tier list with the SAME numbers the engine returns. Mark the
 * source explicitly so a CI run sees the fallback in JSON output.
 */
import chalk from "chalk";
import Table from "cli-table3";
import { TABLE_STYLE } from "../table-style.js";
import { USER_AGENT } from "../user-agent.js";

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
 * Static fallback — used ONLY when engine `/plans` is unreachable.
 * Token counts MUST match the engine (audited 2026-05-13 against
 * engine 3.1.0). If you change the engine, update this fallback in
 * lockstep — or even better, delete it and let the CLI hard-fail.
 */
const FALLBACK_PLANS: DisplayPlan[] = [
  { name: "free", tokens_per_month: 5_000, price_usd: 0, max_d: 9, max_keys: 1, notes: "No card. Default after `zpl login`." },
  { name: "basic", tokens_per_month: 10_000, price_usd: 10, max_d: 16, max_keys: 1, notes: "Personal projects, light dev use." },
  { name: "pro", tokens_per_month: 50_000, price_usd: 29, max_d: 25, max_keys: 3, notes: "Solo developer, daily use." },
  { name: "gamepro", tokens_per_month: 150_000, price_usd: 69, max_d: 32, max_keys: 5, notes: "Game dev studios — loot / economy / matchmaking." },
  { name: "studio", tokens_per_month: 500_000, price_usd: 149, max_d: 48, max_keys: 10, notes: "Mid-size team, multiple projects." },
  { name: "agent", tokens_per_month: 2_000_000, price_usd: 199, max_d: 48, max_keys: 15, notes: "AI-agent workloads — high call volume." },
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

async function fetchEnginePlans(baseUrl: string): Promise<EnginePlan[] | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/plans`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return null;
    const body = (await res.json()) as { plans?: EnginePlan[] };
    return Array.isArray(body.plans) ? body.plans : null;
  } catch {
    return null;
  }
}

export async function cmdPlans(opts: PlansOptions = {}): Promise<void> {
  const output = (opts.output ?? "text").toLowerCase();
  if (output !== "text" && output !== "json") {
    process.stderr.write(chalk.red(`Invalid --output: "${opts.output}". Must be text or json.\n`));
    process.exit(2);
  }

  const baseUrl = opts.baseUrl ?? "https://engine.zeropointlogic.io";
  const fetched = await fetchEnginePlans(baseUrl);

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
    process.stdout.write(
      chalk.yellow(
        `\n(engine /plans unreachable — showing built-in fallback; numbers verified against engine 3.1.0 on 2026-05-13)\n`,
      ),
    );
  }
  process.stdout.write(
    chalk.gray(`\nUpgrade or change plan at ${chalk.cyan("https://zeropointlogic.io/pricing")}.\n`),
  );
}
