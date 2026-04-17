import chalk from "chalk";
import { deleteConfig, getConfigPath } from "../config.js";

export async function cmdLogout(): Promise<void> {
  const removed = deleteConfig();
  if (removed) {
    process.stdout.write(chalk.green(`Logged out. Removed ${getConfigPath()}\n`));
  } else {
    process.stdout.write(chalk.gray(`Nothing to do — no config at ${getConfigPath()}.\n`));
  }
}
