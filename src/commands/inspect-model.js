import {
  getFieldsMeta,
  getModelMeta,
  listModelsMeta,
  META_MODELS_TABLE,
} from "@kiri-orm/core";
import { CliError, UsageError } from "../errors.js";
import { table } from "../format.js";

const RELATION_TYPES = new Set([
  "hasOne",
  "hasMany",
  "belongsTo",
  "belongsToMany",
]);
// Descriptor keys already shown in their own column/flag; everything else is a "constraint" worth listing.
const SHOWN_ELSEWHERE = new Set([
  "type",
  "required",
  "unique",
  "index",
  "column",
  "name",
]);

const parseOptions = (options) =>
  typeof options === "string" ? JSON.parse(options) : (options ?? {});
const isRemoved = (row) =>
  row.removed_at !== null && row.removed_at !== undefined;

export default {
  name: "inspect:model",
  summary:
    "Show a model's table, fields and relations, read from the recorded schema metadata",
  usage: "orm inspect:model <name> [--json] [--include-removed]",
  options: {
    json: {
      type: "boolean",
      description: "print as JSON, with every stored field option",
    },
    "include-removed": {
      type: "boolean",
      description: "also show models/fields that were removed from the code",
    },
  },
  minPositionals: 1,
  maxPositionals: 1,

  async run({ values, positionals, ctx }) {
    const [name] = positionals;
    if (!name) throw new UsageError("inspect:model needs a model name");
    const config = await ctx.loadConfig();
    const includeRemoved = Boolean(values["include-removed"]);

    // Reads only `_meta_models` / `_meta_fields` - no model definitions are needed for this command.
    const found = await ctx.withDb(config, async (db) => {
      if (!(await db.schema.hasTable(META_MODELS_TABLE))) {
        throw new CliError(
          "No schema metadata in this database yet. Run `orm sync` (or `orm migrate:up`) first.",
        );
      }
      const model = await getModelMeta(db, name, { includeRemoved });
      if (!model) {
        const known = (await listModelsMeta(db)).map((row) => row.name);
        const removedRow = includeRemoved
          ? null
          : await getModelMeta(db, name, { includeRemoved: true });
        throw new CliError(
          `Model "${name}" not found in the schema metadata. ` +
            (removedRow
              ? `It exists but was removed from the code; add --include-removed to see it. `
              : "") +
            `Known models: ${known.length > 0 ? known.join(", ") : "(none)"}.`,
        );
      }
      return { model, rows: await getFieldsMeta(db, name, { includeRemoved }) };
    });

    const describeRow = (row) => ({ row, options: parseOptions(row.options) });
    const fields = found.rows
      .filter((row) => !RELATION_TYPES.has(row.type))
      .map(describeRow);
    const relations = found.rows
      .filter((row) => RELATION_TYPES.has(row.type))
      .map(describeRow);

    if (values.json) {
      ctx.out(
        JSON.stringify(
          {
            name: found.model.name,
            table: found.model.table_name,
            removed: isRemoved(found.model),
            fields: fields.map(({ row, options }) => ({
              name: row.name,
              column: row.column,
              type: row.type,
              required: Boolean(row.required),
              unique: Boolean(row.is_unique),
              indexed: Boolean(row.is_indexed),
              removed: isRemoved(row),
              options,
            })),
            relations: relations.map(({ row, options }) => ({
              name: row.name,
              type: row.type,
              removed: isRemoved(row),
              ...options,
            })),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    ctx.out(
      `${found.model.name}  (table: ${found.model.table_name})${isRemoved(found.model) ? "  [REMOVED from the code]" : ""}`,
    );
    ctx.out("");
    ctx.out(`Fields (${fields.length})`);
    const fieldRows = fields.map(({ row, options }) => {
      const flags = [
        row.required && "required",
        row.is_unique && "unique",
        row.is_indexed && "indexed",
        isRemoved(row) && "removed",
      ].filter(Boolean);
      const extras = Object.entries(options)
        .filter(
          ([key, value]) =>
            !SHOWN_ELSEWHERE.has(key) && value !== undefined && value !== null,
        )
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
      return [
        row.name,
        row.column,
        row.type,
        flags.join(", "),
        extras.join(" "),
      ];
    });
    for (const line of table(
      ["NAME", "COLUMN", "TYPE", "FLAGS", "OPTIONS"],
      fieldRows,
    ))
      ctx.out(line);

    if (relations.length > 0) {
      ctx.out("");
      ctx.out(`Relations (${relations.length})`);
      const relationRows = relations.map(({ row, options }) => {
        const details = [
          options.foreignKey && `foreignKey=${options.foreignKey}`,
          options.through && `through=${options.through}`,
          options.otherKey && `otherKey=${options.otherKey}`,
          isRemoved(row) && "removed",
        ].filter(Boolean);
        return [row.name, row.type, options.model ?? "", details.join(" ")];
      });
      for (const line of table(
        ["NAME", "TYPE", "TARGET", "DETAILS"],
        relationRows,
      ))
        ctx.out(line);
    }
    return 0;
  },
};
