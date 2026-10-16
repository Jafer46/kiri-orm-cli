import { syncRegistrySequences } from "@kiri-orm/core";
import { buildRegistry } from "../config.js";
import { CliError } from "../errors.js";
import { plural } from "../format.js";

export default {
  name: "sequences:fix",
  summary:
    "Move each auto-increment id sequence (Postgres) past the ids already in its table",
  usage: "orm sequences:fix [--json]",
  options: {
    json: { type: "boolean", description: "print the result as JSON" },
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
      syncRegistrySequences(db, registry),
    );

    if (values.json) {
      ctx.out(JSON.stringify(result, null, 2));
      return 0;
    }

    const fixed = result.filter((entry) => entry.synced);
    if (fixed.length === 0) {
      ctx.out(
        `Nothing to fix: none of the ${plural(result.length, "model")} has an auto-increment sequence on this database.`,
      );
      return 0;
    }
    ctx.out(
      `Checked ${plural(result.length, "model")}; synced ${plural(fixed.length, "sequence")}: ${fixed.map((entry) => entry.table).join(", ")}`,
    );
    ctx.out("Safe to re-run any time - a sequence is never moved backwards.");
    return 0;
  },
};
