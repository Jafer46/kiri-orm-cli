import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { closeConnection, createConnection } from "@kiri-orm/core";
import { loadConfig } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import sync from "./commands/sync.js";
import migrateGenerate from "./commands/migrate-generate.js";
import migrateUp from "./commands/migrate-up.js";
import migrateDown from "./commands/migrate-down.js";
import generateDto from "./commands/generate-dto.js";
import inspectModel from "./commands/inspect-model.js";
import sequencesFix from "./commands/sequences-fix.js";
import init from "./commands/init.js";

const COMMANDS = [
  sync,
  migrateGenerate,
  migrateUp,
  migrateDown,
  generateDto,
  inspectModel,
  sequencesFix,
  init,
];
const GLOBAL_OPTIONS = {
  config: {
    type: "string",
    short: "c",
    description: "path to the config file (default: ./orm.config.js)",
  },
  help: { type: "boolean", short: "h", description: "show help" },
};

const version = () =>
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    .version;

function optionLines(options) {
  return Object.entries(options).map(([name, spec]) => {
    const flag = `${spec.short ? `-${spec.short}, ` : "    "}--${name}${spec.type === "string" ? " <value>" : ""}`;
    return `  ${flag.padEnd(28)}${spec.description ?? ""}`;
  });
}

function topLevelHelp() {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    "orm - command line for @kiri-orm/core",
    "",
    "Usage: orm <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    "Global options:",
    ...optionLines(GLOBAL_OPTIONS),
    "  --version                   print the version",
    "",
    "Run `orm <command> --help` for a command's options.",
    "Exit codes: 0 success, 1 the command failed, 2 the command line was wrong.",
  ].join("\n");
}

function commandHelp(command) {
  return [
    command.summary,
    "",
    `Usage: ${command.usage}`,
    "",
    "Options:",
    ...optionLines({ ...command.options, ...GLOBAL_OPTIONS }),
  ].join("\n");
}

/**
 * Runs the CLI and returns the process exit code (never calls
 * process.exit itself, so it can be driven in-process too).
 *
 * @param {string[]} argv - arguments after `orm`
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdout?: {write(s: string): unknown}, stderr?: {write(s: string): unknown} }} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}) {
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const out = (line = "") => stdout.write(`${line}\n`);
  const err = (line = "") => stderr.write(`${line}\n`);

  try {
    const [name, ...rest] = argv;

    if (name === undefined) {
      err(topLevelHelp());
      return 2;
    }
    if (name === "--version" || name === "-v") {
      out(version());
      return 0;
    }
    if (name === "help" || name === "--help" || name === "-h") {
      const target = COMMANDS.find((c) => c.name === rest[0]);
      out(target ? commandHelp(target) : topLevelHelp());
      return 0;
    }

    const command = COMMANDS.find((c) => c.name === name);
    if (!command)
      throw new UsageError(
        `Unknown command "${name}". Run \`orm --help\` for the list.`,
      );

    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        options: { ...command.options, ...GLOBAL_OPTIONS },
        allowPositionals: true,
        strict: true,
      });
    } catch (error) {
      throw new UsageError(
        `${error.message}\nRun \`orm ${command.name} --help\` for usage.`,
      );
    }
    const { values, positionals } = parsed;
    if (values.help) {
      out(commandHelp(command));
      return 0;
    }
    if (positionals.length > (command.maxPositionals ?? 0)) {
      throw new UsageError(
        `Unexpected argument "${positionals[command.maxPositionals ?? 0]}". Usage: ${command.usage}`,
      );
    }
    if (positionals.length < (command.minPositionals ?? 0)) {
      throw new UsageError(`Missing argument. Usage: ${command.usage}`);
    }

    const ctx = {
      cwd,
      out,
      err,
      loadConfig: () => loadConfig({ cwd, configPath: values.config, env }),
      async withDb(config, fn) {
        if (!config.connection)
          throw new CliError(
            `${config.file} must export a \`connection\` ({ dialect, filename | connectionString }).`,
          );
        let db;
        try {
          db = createConnection(config.connection);
        } catch (error) {
          throw new CliError(
            `Invalid connection in ${config.file}: ${error.message}`,
          );
        }
        try {
          return await fn(db);
        } finally {
          await closeConnection(db);
        }
      },
    };
    return await command.run({ values, positionals, ctx });
  } catch (error) {
    if (error instanceof CliError) {
      err(
        `${error instanceof UsageError ? "usage error" : "error"}: ${error.message}`,
      );
      return error.exitCode;
    }
    err(
      `error: ${env.ORM_DEBUG ? (error.stack ?? error.message) : error.message}`,
    );
    if (!env.ORM_DEBUG) err("(set ORM_DEBUG=1 for a stack trace)");
    return 1;
  }
}
