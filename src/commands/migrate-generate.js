import { relative } from "node:path";
import {
  generateMigrationFile,
  MigrationSafetyError,
  MigrationStateError,
} from "@kiri-orm/core";
import { buildRegistry } from "../config.js";
import { CliError, UsageError } from "../errors.js";

function parseRenames(pairs = [], flag, format) {
  return pairs.map((pair) => {
    const match = /^([^:]+):([^:]+)$/.exec(pair);
    if (!match)
      throw new UsageError(`${flag} expects ${format}, got "${pair}"`);
    return [match[1], match[2]];
  });
}

export default {
  name: "migrate:generate",
  summary:
    "Diff the models against the recorded schema and write a migration file for the changes",
  usage:
    "orm migrate:generate [name] [--dry-run] [--allow-destructive] [--rename-model old:new] [--rename-field model.old:new]",
  options: {
    "dry-run": {
      type: "boolean",
      description: "show the detected changes, write nothing",
    },
    "allow-destructive": {
      type: "boolean",
      description: "permit dropping models/fields (data in them is lost)",
    },
    "rename-model": {
      type: "string",
      multiple: true,
      description: "treat removed model `old` as renamed to `new`",
    },
    "rename-field": {
      type: "string",
      multiple: true,
      description: "treat removed field `old` on `model` as renamed to `new`",
    },
  },
  maxPositionals: 1,

  async run({ values, positionals, ctx }) {
    const modelRenames = Object.fromEntries(
      parseRenames(values["rename-model"], "--rename-model", "old:new"),
    );
    const fieldRenames = {};
    for (const [from, to] of parseRenames(
      values["rename-field"],
      "--rename-field",
      "model.old:new",
    )) {
      const dot = from.indexOf(".");
      if (dot < 1 || dot === from.length - 1)
        throw new UsageError(
          `--rename-field expects model.old:new, got "${from}:${to}"`,
        );
      (fieldRenames[from.slice(0, dot)] ??= {})[from.slice(dot + 1)] = to;
    }

    const config = await ctx.loadConfig();
    const registry = buildRegistry(config);
    if (!registry)
      throw new CliError(
        `${config.file} declares no models (set \`models\`, \`modules\` or \`registry\`).`,
      );

    let result;
    try {
      result = await ctx.withDb(config, (db) =>
        generateMigrationFile(db, registry, {
          dir: config.migrationsDir,
          name: positionals[0],
          dryRun: values["dry-run"],
          allowDestructive: values["allow-destructive"],
          modelRenames,
          fieldRenames,
        }),
      );
    } catch (error) {
      if (error instanceof MigrationSafetyError && error.planLines) {
        ctx.err("Detected changes:");
        for (const line of error.planLines) ctx.err(`  ${line}`);
        ctx.err("");
      }
      if (
        error instanceof MigrationSafetyError ||
        error instanceof MigrationStateError
      )
        throw new CliError(error.message);
      throw error;
    }

    if (result.file === null && !values["dry-run"]) {
      ctx.out("No changes detected - the models match the recorded schema.");
      return 0;
    }
    ctx.out("Detected changes:");
    for (const line of result.summary) ctx.out(`  ${line}`);
    if (values["dry-run"]) {
      ctx.out("(dry run - no file written)");
      return 0;
    }
    ctx.out(`Created ${relative(ctx.cwd, result.file)}`);
    ctx.out("Review it, then run `orm migrate:up`.");
    return 0;
  },
};
