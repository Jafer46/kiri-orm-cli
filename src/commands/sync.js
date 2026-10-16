import { sync } from "@kiri-orm/core";
import { buildRegistry } from "../config.js";
import { CliError } from "../errors.js";
import { plural } from "../format.js";

export default {
  name: "sync",
  summary:
    "Create missing tables/columns for every model and refresh the recorded schema metadata",
  usage: "orm sync [--add-missing-foreign-keys] [--json]",
  options: {
    json: { type: "boolean", description: "print the result as JSON" },
    "add-missing-foreign-keys": {
      type: "boolean",
      description:
        "add foreign key constraints that tables created before foreign keys existed lack (fails if rows already violate them)",
    },
  },
  maxPositionals: 0,

  async run({ values, ctx }) {
    const config = await ctx.loadConfig();
    const registry = buildRegistry(config);
    if (!registry)
      throw new CliError(
        `${config.file} declares no models (set \`models\`, \`modules\` or \`registry\`).`,
      );

    const result = await ctx.withDb(config, (db) =>
      sync(db, registry, {
        columnBuilderRegistry: config.columnBuilderRegistry,
        addMissingForeignKeys: values["add-missing-foreign-keys"] === true,
      }),
    );

    if (values.json) {
      ctx.out(JSON.stringify(result, null, 2));
      return 0;
    }

    const added = Object.entries(result.columnsAdded);
    const nothingChanged =
      result.tablesCreated.length === 0 &&
      added.length === 0 &&
      result.foreignKeysAdded.length === 0;
    if (nothingChanged) {
      ctx.out(
        `Schema already up to date (${plural(registry.listModels().length, "model")}).`,
      );
    } else {
      ctx.out(`Synced ${plural(registry.listModels().length, "model")}.`);
      if (result.tablesCreated.length > 0)
        ctx.out(`  created tables: ${result.tablesCreated.join(", ")}`);
      for (const [table, columns] of added)
        ctx.out(`  added columns:  ${table}.${columns.join(`, ${table}.`)}`);
      for (const key of result.foreignKeysAdded)
        ctx.out(`  foreign key:    ${key}`);
    }
    for (const warning of result.warnings) ctx.err(`warning: ${warning}`);
    // sync() is additive by design; make removals visible rather than silent.
    const removed = [
      ...result.meta.modelsRemoved,
      ...result.meta.fieldsRemoved,
    ];
    if (removed.length > 0) {
      ctx.out(
        `Flagged as removed in the metadata (nothing was dropped): ${removed.join(", ")}`,
      );
      ctx.out(
        "  Use `orm migrate:generate` to produce a migration for removals.",
      );
    }
    return 0;
  },
};
