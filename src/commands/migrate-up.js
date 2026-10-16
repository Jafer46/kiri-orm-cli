import { migrateUp, MigrationStateError } from "@kiri-orm/core";
import { buildRegistry } from "../config.js";
import { CliError, UsageError } from "../errors.js";
import { plural } from "../format.js";

export function parseSteps(value) {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value))
    throw new UsageError(`--steps expects a positive integer, got "${value}"`);
  return Number(value);
}

export default {
  name: "migrate:up",
  summary: "Apply pending migrations, oldest first",
  usage: "orm migrate:up [--steps <n>]",
  options: {
    steps: { type: "string", description: "apply at most n migrations" },
  },
  maxPositionals: 0,

  async run({ values, ctx }) {
    const steps = parseSteps(values.steps);
    const config = await ctx.loadConfig();
    const registry = buildRegistry(config); // optional here: only used to ensure pivot tables

    let result;
    try {
      result = await ctx.withDb(config, (db) =>
        migrateUp(db, {
          dir: config.migrationsDir,
          steps,
          modelRegistry: registry ?? undefined,
          columnBuilderRegistry: config.columnBuilderRegistry,
          onApply: (name, summary) => {
            ctx.out(`Applied ${name}`);
            for (const line of summary) ctx.out(`    ${line}`);
          },
        }),
      );
    } catch (error) {
      if (error instanceof MigrationStateError)
        throw new CliError(error.message);
      throw error;
    }

    if (result.applied.length === 0) ctx.out("Nothing to migrate.");
    else ctx.out(`Applied ${plural(result.applied.length, "migration")}.`);
    if (result.pivotTablesCreated.length > 0)
      ctx.out(
        `Created pivot table(s) for belongsToMany relations: ${result.pivotTablesCreated.join(", ")}`,
      );
    return 0;
  },
};
