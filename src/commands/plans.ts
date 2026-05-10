/**
 * `zpl plans` — list all ZPL plans with monthly token quota and price.
 *
 * Static catalogue maintained in this file so users can decide on upgrades
 * without leaving the terminal. Source of truth: zeropointlogic.io/pricing.
 * If you change pricing on the website, update PLANS here and bump the
 * minor version so npm consumers get the fresh list on next upgrade.
 */
import chalk from "chalk";
import Table from "cli-table3";

interface Plan {
  name: string;
  monthly_tokens: number;
  price_eur_month: number;
  notes: string;
}

const PLANS: Plan[] = [
  { name: "Free", monthly_tokens: 5_000, price_eur_month: 0, notes: "No card. Default plan after `zpl login`." },
  { name: "Basic", monthly_tokens: 50_000, price_eur_month: 10, notes: "Personal projects, light dev use." },
  { name: "Pro", monthly_tokens: 250_000, price_eur_month: 29, notes: "Solo developer, daily use." },
  { name: "GamePro", monthly_tokens: 750_000, price_eur_month: 69, notes: "Game dev studios — loot/economy/matchmaking heavy." },
  { name: "Studio", monthly_tokens: 2_000_000, price_eur_month: 149, notes: "Mid-size team, multiple projects." },
  { name: "Agent", monthly_tokens: 3_500_000, price_eur_month: 199, notes: "AI-agent workloads — high call volume." },
  { name: "Enterprise", monthly_tokens: 10_000_000, price_eur_month: 499, notes: "SLA + priority support." },
  { name: "XL", monthly_tokens: 25_000_000, price_eur_month: 999, notes: "Highest-volume tier, dedicated capacity." },
];

export interface PlansOptions {
  output?: "text" | "json";
}

export async function cmdPlans(opts: PlansOptions = {}): Promise<void> {
  const output = (opts.output ?? "text").toLowerCase();
  if (output !== "text" && output !== "json") {
    process.stderr.write(chalk.red(`Invalid --output: "${opts.output}". Must be text or json.\n`));
    process.exit(2);
  }

  if (output === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          source: "zeropointlogic.io/pricing",
          currency: "EUR",
          billing: "monthly",
          plans: PLANS,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const table = new Table({
    head: [chalk.bold("Plan"), chalk.bold("Tokens/month"), chalk.bold("EUR/month"), chalk.bold("Notes")],
    style: { head: [] },
    colWidths: [12, 16, 12, 50],
    wordWrap: true,
  });
  for (const p of PLANS) {
    const priceCell = p.price_eur_month === 0 ? chalk.green("Free") : `€${p.price_eur_month}`;
    table.push([p.name, p.monthly_tokens.toLocaleString(), priceCell, p.notes]);
  }
  process.stdout.write(table.toString() + "\n");
  process.stdout.write(
    "\n" +
      chalk.gray(`Upgrade or change plan at ${chalk.cyan("https://zeropointlogic.io/pricing")}.\n`),
  );
}
