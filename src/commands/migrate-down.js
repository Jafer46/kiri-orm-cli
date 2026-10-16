import { migrateDown, MigrationStateError } from "@kiri-orm/core";
import { CliError, UsageError } from "../errors.js";
import { plural } from "../format.js";
import { parseSteps } from "./migrate-up.js";

export default {
  name: "migrate:down",
  summary:
    "Roll back the most recently applied migration (or --steps n / --all)",
  usage: "orm migrate:down [--steps <n> | --all]",
  options: {
    steps: {
      type: "string",
      description: "roll back n migrations (default 1)",
    },
    all: { type: "boolean", description: "roll back every applied migration" },
  },
  maxPositionals: 0,

  async run({ values, ctx }) {
    if (values.all && values.steps !== undefined)
      throw new UsageError("--steps and --all can't be combined");
    const steps = parseSteps(values.steps);
    const config = await ctx.loadConfig();

    let result;
    try {
      result = await ctx.withDb(config, (db) =>
        migrateDown(db, {
          dir: config.migrationsDir,
          steps,
          all: values.all,
          columnBuilderRegistry: config.columnBuilderRegistry,
          onRollback: (name, summary) => {
            ctx.out(`Rolled back ${name}`);
            for (const line of summary) ctx.out(`    (undoes) ${line}`);
          },
        }),
      );
    } catch (error) {
      if (error instanceof MigrationStateError)
        throw new CliError(error.message);
      throw error;
    }

    if (result.rolledBack.length === 0) ctx.out("Nothing to roll back.");
    else
      ctx.out(`Rolled back ${plural(result.rolledBack.length, "migration")}.`);
    return 0;
  },
};
