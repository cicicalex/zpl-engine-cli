import { hostname } from "node:os";
import chalk from "chalk";
import {
  DEFAULT_SITE,
  buildApproveUrl,
  openInBrowser,
  startDeviceFlow,
  waitForApproval,
} from "../device-flow.js";
import { writeConfig, getConfigPath } from "../config.js";

export async function cmdLogin(): Promise<void> {
  const site = DEFAULT_SITE;
  const deviceName = hostname();

  let start;
  try {
    start = await startDeviceFlow(site, deviceName);
  } catch (err) {
    process.stderr.write(chalk.red(`Could not start login: ${(err as Error).message}\n`));
    process.exit(1);
  }

  const approveUrl = buildApproveUrl(start);
  process.stdout.write("\n");
  process.stdout.write(chalk.bold("Your code:\n\n"));
  process.stdout.write(`    ${chalk.cyan.bold(start.user_code)}\n\n`);
  process.stdout.write(`Opening ${chalk.gray(approveUrl)}\n`);
  process.stdout.write(chalk.gray("(If your browser does not open, paste the URL above.)\n\n"));

  openInBrowser(approveUrl);

  let approved;
  try {
    approved = await waitForApproval(site, start);
  } catch (err) {
    process.stderr.write(chalk.red(`${(err as Error).message}\n`));
    process.exit(1);
  }

  writeConfig({
    auth: {
      api_key: approved.api_key,
      user_email: approved.user_email,
      created_at: new Date().toISOString(),
    },
    engine: { base_url: "https://engine.zeropointlogic.io" },
    defaults: { model: "claude-haiku-4-5" },
  });

  const plan = approved.user_plan ?? "free";
  process.stdout.write(
    chalk.green(`Logged in as ${approved.user_email} (plan: ${plan}).\n`),
  );
  process.stdout.write(chalk.gray(`Config saved to ${getConfigPath()}\n`));
}
