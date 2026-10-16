import { describe, it, expect } from "vitest";
import { BLOG, eachCliDialect, invoice, runCli, withProject } from "../helpers/project.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Things that don't depend on a database at all
// ---------------------------------------------------------------------------
describe("orm - command line handling", () => {
  const scratch = () => mkdtemp(join(tmpdir(), "orm-cli-bare-"));

  it("--help lists every command and documents the exit codes", async () => {
    const { code, stdout } = await runCli(["--help"], { cwd: await scratch() });
    expect(code).toBe(0);
    for (const name of ["sync", "migrate:generate", "migrate:up", "migrate:down", "generate:dto", "inspect:model", "sequences:fix"]) {
      expect(stdout).toContain(name);
    }
    expect(stdout).toMatch(/Exit codes: 0 success, 1 .* 2 /);
  });

  it("`orm <command> --help` shows that command's usage and options", async () => {
    const { code, stdout } = await runCli(["migrate:generate", "--help"], { cwd: await scratch() });
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: orm migrate:generate");
    expect(stdout).toContain("--allow-destructive");
    expect(stdout).toContain("--rename-field");
  });

  it("--version prints the package version", async () => {
    const { code, stdout } = await runCli(["--version"], { cwd: await scratch() });
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exits 2 with a usage error for an unknown command, unknown flag, missing or extra argument", async () => {
    const cwd = await scratch();
    const unknown = await runCli(["frobnicate"], { cwd });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/usage error: Unknown command "frobnicate"/);
    expect(unknown.stdout).toBe("");

    expect((await runCli(["sync", "--nope"], { cwd })).code).toBe(2);
    expect((await runCli(["inspect:model"], { cwd })).code).toBe(2);
    const extra = await runCli(["sync", "surplus"], { cwd });
    expect(extra.code).toBe(2);
    expect(extra.stderr).toMatch(/Unexpected argument "surplus"/);
    expect((await runCli([], { cwd })).code).toBe(2); // bare `orm`
  });

  it("exits 1, naming what it looked for, when there is no config file", async () => {
    const { code, stderr } = await runCli(["sync"], { cwd: await scratch() });
    expect(code).toBe(1);
    expect(stderr).toMatch(/No config file found/);
    expect(stderr).toContain("orm.config.js");
  });

  it("reports a bad --config path, an unloadable config, and a bad connection as errors, not crashes", async () => {
    const cwd = await scratch();
    const missing = await runCli(["sync", "--config", "nope.mjs"], { cwd });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/Config file not found/);

    await writeFile(join(cwd, "broken.mjs"), "export default { connection: ;");
    const broken = await runCli(["sync", "-c", "broken.mjs"], { cwd });
    expect(broken.code).toBe(1);
    expect(broken.stderr).toMatch(/Could not load config/);

    await writeFile(join(cwd, "badconn.mjs"), `export default { connection: { dialect: "oracle" }, models: [{ name: "a", fields: { id: { type: "integer" } } }] };`);
    const bad = await runCli(["sync", "-c", "badconn.mjs"], { cwd });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/Invalid connection/);
    expect(bad.stderr).not.toMatch(/\n\s+at /); // no stack trace for expected failures

    await writeFile(join(cwd, "nomodels.mjs"), `export default { connection: { dialect: "sqlite", filename: ":memory:" } };`);
    const none = await runCli(["sync", "-c", "nomodels.mjs"], { cwd });
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/declares no models/);
  });

  it("accepts a config that is a function of the environment", async () => {
    const cwd = await scratch();
    await writeFile(
      join(cwd, "orm.config.mjs"),
      `export default ({ env }) => ({ connection: { dialect: "sqlite", filename: env.SCRATCH_DB }, models: [{ name: "a", fields: { id: { type: "integer" } } }] });`
    );
    const { code, stdout } = await runCli(["sync"], { cwd, env: { SCRATCH_DB: join(cwd, "env.db") } });
    expect(code).toBe(0);
    expect(stdout).toMatch(/created tables: a/);
  });

  it("resolves a relative SQLite path against the config file, so it works from a subdirectory", async () => {
    const cwd = await scratch();
    await writeFile(
      join(cwd, "orm.config.mjs"),
      `export default { connection: { dialect: "sqlite", filename: "./app.db" }, models: [{ name: "a", fields: { id: { type: "integer" } } }] };`
    );
    await mkdir(join(cwd, "sub"));
    const fromSub = await runCli(["sync", "--config", "../orm.config.mjs"], { cwd: join(cwd, "sub") });
    expect(fromSub.code).toBe(0);
    const again = await runCli(["sync"], { cwd }); // same database, found from the project root
    expect(again.stdout).toMatch(/already up to date/);
  });
});

// ---------------------------------------------------------------------------
// Commands, against a scratch database
// ---------------------------------------------------------------------------
describe.each(eachCliDialect())("orm sync - $name", ({ name: dialect }) => {
  it("creates tables, then reports up to date, then adds only what's new", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      const first = await project.orm("sync");
      expect(first.code).toBe(0);
      expect(first.stdout).toContain("Synced 3 models.");
      expect(first.stdout).toContain("created tables: post, comment, tag");
      expect(await project.columns("post")).toEqual(["id", "title"]);
      expect(await project.columns("post_tag")).toEqual(["post_id", "tag_id"]); // pivot for the belongsToMany

      const second = await project.orm("sync");
      expect(second.code).toBe(0);
      expect(second.stdout).toMatch(/Schema already up to date \(3 models\)/);

      await project.writeConfig(BLOG.map((m) => (m.name === "tag" ? { ...m, fields: { ...m.fields, color: { type: "char" } } } : m)));
      const third = await project.orm("sync");
      expect(third.stdout).toContain("added columns:  tag.color");
      expect(await project.columns("tag")).toEqual(["color", "id", "name"]);
    }));

  it("--json prints the structured result", () =>
    withProject({ dialect, models: [invoice({ total: { type: "float" } })] }, async (project) => {
      const { code, stdout } = await project.orm("sync --json");
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.tablesCreated).toEqual(["invoice"]);
      expect(result.meta.fieldsUpserted).toEqual(["invoice.id", "invoice.total"]);
    }));

  it("says removals were only flagged, never dropped", () =>
    withProject({ dialect, models: [invoice({ total: { type: "float" } })] }, async (project) => {
      await project.orm("sync");
      await project.writeConfig([invoice()]);
      const { code, stdout } = await project.orm("sync");
      expect(code).toBe(0);
      expect(stdout).toMatch(/Flagged as removed in the metadata \(nothing was dropped\): invoice\.total/);
      expect(await project.columns("invoice")).toEqual(["id", "total"]); // still there
    }));

  it("fails cleanly with exit 1 on an invalid model definition", () =>
    withProject({ dialect, models: [{ name: "x", fields: { id: { type: "no-such-type" } } }] }, async (project) => {
      const { code, stderr } = await project.orm("sync");
      expect(code).toBe(1);
      expect(stderr).toMatch(/Invalid model/);
    }));
});

describe.each(eachCliDialect())("orm inspect:model - $name", ({ name: dialect }) => {
  it("prints the table, fields with flags and options, and relations - from _meta_fields", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      await project.orm("sync");
      const { code, stdout } = await project.orm("inspect:model post");
      expect(code).toBe(0);
      expect(stdout).toContain("post  (table: post)");
      expect(stdout).toMatch(/title\s+title\s+char\s+required, unique\s+maxLength=80/);
      expect(stdout).toMatch(/id\s+id\s+integer\s+required/);
      expect(stdout).toContain("Relations (2)");
      expect(stdout).toMatch(/comments\s+hasMany\s+comment\s+foreignKey=postId/);
      expect(stdout).toMatch(/tags\s+belongsToMany\s+tag\s+foreignKey=post_id through=post_tag otherKey=tag_id/);
    }));

  it("--json is machine-readable and keeps every stored option", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      await project.orm("sync");
      const { code, stdout } = await project.orm("inspect:model post --json");
      expect(code).toBe(0);
      const model = JSON.parse(stdout);
      expect(model).toMatchObject({ name: "post", table: "post", removed: false });
      const title = model.fields.find((f) => f.name === "title");
      expect(title).toMatchObject({ column: "title", type: "char", required: true, unique: true, indexed: false });
      expect(title.options.maxLength).toBe(80);
      expect(model.relations.map((r) => [r.name, r.type, r.model])).toEqual([["comments", "hasMany", "comment"], ["tags", "belongsToMany", "tag"]]);
    }));

  it("needs no model definitions - only the connection - so it works on a database another app built", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      await project.orm("sync");
      await project.write("orm.config.mjs", (await project.read("orm.config.mjs")).replace(/models:[\s\S]*\n\s*\n?\};/, "};"));
      const bare = await project.orm("inspect:model tag");
      expect(bare.code).toBe(0);
      expect(bare.stdout).toContain("tag  (table: tag)");
    }));

  it("names the known models when the requested one doesn't exist", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      await project.orm("sync");
      const { code, stderr, stdout } = await project.orm("inspect:model ghost");
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toMatch(/Model "ghost" not found.*Known models: comment, post, tag/);
    }));

  it("tells you to sync first when there's no metadata yet", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      const { code, stderr } = await project.orm("inspect:model post");
      expect(code).toBe(1);
      expect(stderr).toMatch(/No schema metadata.*orm sync/);
    }));

  it("hides models removed from the code unless --include-removed", () =>
    withProject({ dialect, models: [invoice(), { name: "old", fields: { id: { type: "integer" } } }] }, async (project) => {
      await project.orm("sync");
      await project.writeConfig([invoice()]);
      await project.orm("sync"); // flags `old` as removed

      const hidden = await project.orm("inspect:model old");
      expect(hidden.code).toBe(1);
      expect(hidden.stderr).toMatch(/removed from the code; add --include-removed/);

      const shown = await project.orm("inspect:model old --include-removed");
      expect(shown.code).toBe(0);
      expect(shown.stdout).toContain("[REMOVED from the code]");
    }));
});

describe.each(eachCliDialect())("orm generate:dto - $name", ({ name: dialect }) => {
  it("writes JSON Schemas and JSDoc types for every model", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      const { code, stdout } = await project.orm("generate:dto");
      expect(code).toBe(0);
      expect(stdout).toContain("Generated DTOs for 3 models:");
      expect(stdout).toMatch(/dto[\\/]schemas\.json/);

      const schemas = JSON.parse(await project.read("dto/schemas.json"));
      expect(Object.keys(schemas).sort()).toEqual(["comment", "post", "tag"]);
      expect(Object.keys(schemas.post)).toEqual(["create", "update", "read"]);
      expect(schemas.post.create.required).toContain("title");
      expect(schemas.post.create.properties.title.maxLength).toBe(80);

      const types = await project.read("dto/types.js");
      expect(types).toContain("Generated by `orm generate:dto`");
      expect(types).toMatch(/@typedef \{Object\} CreatePost/);
      expect(types).toMatch(/@typedef \{Object\} ReadPost/);
    }));

  it("--out and --format choose where and what", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      const json = await project.orm("generate:dto --out generated/api --format json");
      expect(json.code).toBe(0);
      expect(await project.list("generated/api")).toEqual(["schemas.json"]);

      const doc = await project.orm("generate:dto --out generated/docs --format jsdoc");
      expect(doc.code).toBe(0);
      expect(await project.list("generated/docs")).toEqual(["types.js"]);
    }));

  it("honors `dtoDir` from the config", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      await project.writeConfig(BLOG, `dtoDir: "src/dto",`);
      expect((await project.orm("generate:dto")).code).toBe(0);
      expect(await project.list("src/dto")).toEqual(["schemas.json", "types.js"]);
    }));

  it("rejects an unknown --format with a usage error and writes nothing", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      const { code, stderr } = await project.orm("generate:dto --format yaml");
      expect(code).toBe(2);
      expect(stderr).toMatch(/--format expects one of both, json, jsdoc/);
      expect(await project.list("dto")).toEqual([]);
    }));

  it("doesn't touch the database at all", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      await project.orm("generate:dto");
      expect(await project.columns("post")).toBeNull();
    }));
});

describe.each(eachCliDialect())("orm migrate:* - $name", ({ name: dialect }) => {
  const FILE = /migrations[\\/](\d{14}_[a-z0-9_]+\.js)/;

  it("generate -> up -> (nothing left to generate) -> down -> (change is pending again)", () =>
    withProject({ dialect, models: [invoice({ total: { type: "float" } })] }, async (project) => {
      const gen = await project.orm("migrate:generate");
      expect(gen.code).toBe(0);
      expect(gen.stdout).toContain("Detected changes:");
      expect(gen.stdout).toContain('[safe]        create model "invoice"');
      const file = FILE.exec(gen.stdout)[1];
      expect(file).toMatch(/_create_invoice\.js$/);
      expect(await project.columns("invoice")).toBeNull(); // generating changes nothing in the database

      const source = await project.read(`migrations/${file}`);
      expect(source).toContain("export async function up(");
      expect(source).toContain("export async function down(");
      expect(source).toContain('createTable("invoice"');

      const up = await project.orm("migrate:up");
      expect(up.code).toBe(0);
      expect(up.stdout).toContain(`Applied ${file.replace(".js", "")}`);
      expect(up.stdout).toContain("Applied 1 migration.");
      expect(await project.columns("invoice")).toEqual(["id", "total"]);
      expect((await project.orm("inspect:model invoice")).stdout).toMatch(/total\s+total\s+float/); // metadata followed

      const again = await project.orm("migrate:generate");
      expect(again.code).toBe(0);
      expect(again.stdout).toMatch(/No changes detected/);

      const down = await project.orm("migrate:down");
      expect(down.code).toBe(0);
      expect(down.stdout).toContain(`Rolled back ${file.replace(".js", "")}`);
      expect(await project.columns("invoice")).toBeNull();
      expect((await project.orm("inspect:model invoice")).code).toBe(1); // metadata went back too

      const up2 = await project.orm("migrate:up"); // the file is still there, pending again
      expect(up2.stdout).toContain("Applied 1 migration.");
    }));

  it("--dry-run shows the changes and writes nothing", () =>
    withProject({ dialect, models: [invoice()] }, async (project) => {
      const { code, stdout } = await project.orm("migrate:generate --dry-run");
      expect(code).toBe(0);
      expect(stdout).toContain('create model "invoice"');
      expect(stdout).toContain("dry run - no file written");
      expect(await project.list("migrations")).toEqual([]);
    }));

  it("takes a name, and honors `migrationsDir` from the config", () =>
    withProject({ dialect, models: [invoice()] }, async (project) => {
      await project.writeConfig([invoice()], `migrationsDir: "db/migrate",`);
      const { code, stdout } = await project.orm(["migrate:generate", "Add Invoices!"]);
      expect(code).toBe(0);
      expect(stdout).toMatch(/db[\\/]migrate[\\/]\d{14}_add_invoices\.js/);
      expect((await project.list("db/migrate"))).toHaveLength(1);
      expect((await project.orm("migrate:up")).stdout).toContain("Applied 1 migration.");
    }));

  it("refuses destructive changes with exit 1 (showing the plan) unless --allow-destructive", () =>
    withProject({ dialect, models: [invoice({ total: { type: "float" } })] }, async (project) => {
      await project.orm("migrate:generate");
      await project.orm("migrate:up");
      await project.writeConfig([invoice()]); // `total` removed from the code

      const refused = await project.orm("migrate:generate");
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/\[DESTRUCTIVE\] invoice: drop field "total"/);
      expect(refused.stderr).toMatch(/not explicitly allowed/);
      expect(await project.list("migrations")).toHaveLength(1); // no second file

      const allowed = await project.orm("migrate:generate --allow-destructive");
      expect(allowed.code).toBe(0);
      expect((await project.orm("migrate:up")).code).toBe(0);
      expect(await project.columns("invoice")).toEqual(["id"]);
      expect((await project.orm("migrate:down")).code).toBe(0);
      expect(await project.columns("invoice")).toEqual(["id", "total"]); // shape restored
    }));

  it("never auto-generates a field type change, even with --allow-destructive", () =>
    withProject({ dialect, models: [invoice({ total: { type: "float" } })] }, async (project) => {
      await project.orm("migrate:generate");
      await project.orm("migrate:up");
      await project.writeConfig([invoice({ total: { type: "integer" } })]);
      const { code, stderr } = await project.orm("migrate:generate --allow-destructive");
      expect(code).toBe(1);
      expect(stderr).toMatch(/field type changes/);
      expect(stderr).toMatch(/\[MANUAL\]/);
    }));

  it("resolves renames named with --rename-field", () =>
    withProject({ dialect, models: [invoice({ total: { type: "float" } })] }, async (project) => {
      await project.orm("migrate:generate");
      await project.orm("migrate:up");
      await project.db((db) => db("invoice").insert({ id: 1, total: 12.5 }));
      await project.writeConfig([invoice({ amount: { type: "float" } })]);

      const ambiguous = await project.orm("migrate:generate --dry-run"); // without the hint: drop + add
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.stderr).toMatch(/\[ambiguous\].*possible field rename/);

      const gen = await project.orm("migrate:generate --rename-field invoice.total:amount");
      expect(gen.code).toBe(0);
      expect(gen.stdout).toMatch(/rename field "total" -> "amount"/);
      expect((await project.orm("migrate:up")).code).toBe(0);
      expect(await project.db((db) => db("invoice").first())).toMatchObject({ id: 1, amount: 12.5 }); // data followed
    }));

  it("rejects malformed rename flags as usage errors", () =>
    withProject({ dialect, models: [invoice()] }, async (project) => {
      const a = await project.orm("migrate:generate --rename-model nocolon");
      expect(a.code).toBe(2);
      expect(a.stderr).toMatch(/--rename-model expects old:new/);
      const b = await project.orm("migrate:generate --rename-field nodot:x");
      expect(b.code).toBe(2);
      expect(b.stderr).toMatch(/--rename-field expects model\.old:new/);
    }));

  it("won't generate on top of unapplied migrations", () =>
    withProject({ dialect, models: [invoice()] }, async (project) => {
      await project.orm("migrate:generate");
      await project.writeConfig([invoice({ total: { type: "float" } })]);
      const { code, stderr } = await project.orm("migrate:generate");
      expect(code).toBe(1);
      expect(stderr).toMatch(/have not been applied yet/);
      expect(await project.list("migrations")).toHaveLength(1);
    }));

  it("--steps limits how far up and down go; --all rolls everything back", () =>
    withProject({ dialect, models: [invoice()] }, async (project) => {
      const stages = [{}, { a: { type: "float" } }, { a: { type: "float" }, b: { type: "float" } }];
      for (const fields of stages) {
        await project.writeConfig([invoice(fields)]);
        expect((await project.orm("migrate:generate")).code).toBe(0);
        expect((await project.orm("migrate:up")).code).toBe(0);
      }
      expect(await project.columns("invoice")).toEqual(["a", "b", "id"]);

      const down2 = await project.orm("migrate:down --steps 2");
      expect(down2.stdout).toContain("Rolled back 2 migrations.");
      expect(await project.columns("invoice")).toEqual(["id"]);

      const up1 = await project.orm("migrate:up --steps 1");
      expect(up1.stdout).toContain("Applied 1 migration.");
      expect(await project.columns("invoice")).toEqual(["a", "id"]);

      const all = await project.orm("migrate:down --all");
      expect(all.stdout).toContain("Rolled back 2 migrations.");
      expect(await project.columns("invoice")).toBeNull();

      expect((await project.orm("migrate:down")).stdout).toContain("Nothing to roll back.");
      expect((await project.orm("migrate:up")).stdout).toContain("Applied 3 migrations.");
      expect((await project.orm("migrate:up")).stdout).toContain("Nothing to migrate.");
    }));

  it("validates --steps / --all", () =>
    withProject({ dialect, models: [invoice()] }, async (project) => {
      for (const bad of ["migrate:up --steps 0", "migrate:up --steps abc", "migrate:down --steps -1", "migrate:down --steps 1 --all"]) {
        expect((await project.orm(bad)).code, bad).toBe(2);
      }
    }));

  it("a failing migration exits 1 and leaves the database exactly as it was", () =>
    withProject({ dialect, models: [invoice()] }, async (project) => {
      await project.orm("migrate:generate");
      await project.orm("migrate:up");
      await project.write(
        "migrations/29990101000000_half_done.js",
        `export const summary = ["adds a column, then fails"];
export async function up(db) {
  await db.schema.alterTable("invoice", (t) => t.integer("extra"));
  throw new Error("boom halfway");
}
export async function down() {}
export const meta = {};
`
      );
      const { code, stderr } = await project.orm("migrate:up");
      expect(code).toBe(1);
      expect(stderr).toContain("boom halfway");
      expect(await project.columns("invoice")).toEqual(["id"]); // the ALTER rolled back with it
      expect((await project.orm("migrate:up")).code).toBe(1); // still pending, still failing - not marked applied
    }));

  it("stops with exit 1 when an applied migration's file has gone missing", () =>
    withProject({ dialect, models: [invoice()] }, async (project) => {
      const gen = await project.orm("migrate:generate");
      await project.orm("migrate:up");
      const { rm } = await import("node:fs/promises");
      await rm(join(project.dir, "migrations", FILE.exec(gen.stdout)[1]));
      const { code, stderr } = await project.orm("migrate:down");
      expect(code).toBe(1);
      expect(stderr).toMatch(/recorded as applied but their files are missing/);
    }));

  it("relations don't show up as phantom changes, and migrate:up creates pivot tables", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      const gen = await project.orm("migrate:generate");
      expect(gen.code).toBe(0);
      expect(gen.stdout).toContain('create model "post"');
      const up = await project.orm("migrate:up");
      expect(up.stdout).toMatch(/Created pivot table\(s\) for belongsToMany relations: post_tag/);
      expect(await project.columns("post_tag")).toEqual(["post_id", "tag_id"]);
      expect((await project.orm("migrate:generate")).stdout).toMatch(/No changes detected/);
      expect((await project.orm("inspect:model post")).stdout).toContain("Relations (2)");
    }));

  it("picks up where `orm sync` left off: relations there don't read as removed fields", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      await project.orm("sync");
      const { code, stdout } = await project.orm("migrate:generate");
      expect(code).toBe(0);
      expect(stdout).toMatch(/No changes detected/);
    }));
});

// ---------------------------------------------------------------------------
// Model inheritance and computed fields, driven from the config's `modules`
// ---------------------------------------------------------------------------
describe.each(eachCliDialect())("orm with extension packages, mixins and computed fields - $name", ({ name: dialect }) => {
  // Config source is spliced in verbatim, so it can hold functions (compute/search) that JSON can't.
  const BLOG_MODULE = `{ name: "blog", models: [
      { name: "post", fields: { id: { type: "integer", required: true }, title: { type: "char", required: true } } } ] }`;
  const SEO_MODULE = `{ name: "seo", models: [
      { extend: "post", fields: { seoTitle: { type: "char", maxLength: 70 } } } ] }`;

  it("`orm sync` merges an extension into the base model's table, even when the extension is listed first", () =>
    withProject({ dialect }, async (project) => {
      await project.writeConfig([], `modules: [${SEO_MODULE}, ${BLOG_MODULE}],`);
      const sync = await project.orm("sync");
      expect(sync.code).toBe(0);
      expect(sync.stdout).toContain("Synced 1 model.");
      expect(sync.stdout).toContain("created tables: post");
      expect(await project.columns("post")).toEqual(["id", "seo_title", "title"]);

      const inspect = await project.orm("inspect:model post");
      expect(inspect.stdout).toMatch(/seoTitle\s+seo_title\s+char\s+maxLength=70/);
    }));

  it("a package added later becomes a migration for the model it extends", () =>
    withProject({ dialect }, async (project) => {
      await project.writeConfig([], `modules: [${BLOG_MODULE}],`);
      expect((await project.orm("migrate:generate")).code).toBe(0);
      expect((await project.orm("migrate:up")).code).toBe(0);
      expect(await project.columns("post")).toEqual(["id", "title"]);

      await project.writeConfig([], `modules: [${BLOG_MODULE}, ${SEO_MODULE}],`);
      const gen = await project.orm("migrate:generate");
      expect(gen.code).toBe(0);
      expect(gen.stdout).toContain('[safe]        post: add field "seoTitle"');
      expect((await project.orm("migrate:up")).code).toBe(0);
      expect(await project.columns("post")).toEqual(["id", "seo_title", "title"]);
      expect((await project.orm("migrate:generate")).stdout).toMatch(/No changes detected/);
    }));

  it("an extension whose base model is never defined is a clear error naming its module", () =>
    withProject({ dialect }, async (project) => {
      await project.writeConfig([], `modules: [${SEO_MODULE}],`);
      for (const command of ["sync", "migrate:generate", "generate:dto"]) {
        const { code, stderr } = await project.orm(command);
        expect(code, command).toBe(1);
        expect(stderr, command).toMatch(/Invalid model in .*Extension of "post" \(from module "seo"\) needs "post"/s);
        expect(stderr, command).not.toMatch(/\n\s+at /);
      }
    }));

  it("mixins give each model its own columns and never become a table", () =>
    withProject({ dialect }, async (project) => {
      await project.writeConfig(
        [
          { name: "stamped", abstract: true, fields: { createdBy: { type: "char" } } },
          { name: "invoice", mixins: ["stamped"], fields: { id: { type: "integer" } } },
          { name: "customer", mixins: ["stamped"], fields: { id: { type: "integer" } } },
        ]
      );
      const { code, stdout } = await project.orm("sync");
      expect(code).toBe(0);
      expect(stdout).toContain("Synced 2 models.");
      expect(await project.columns("invoice")).toEqual(["created_by", "id"]);
      expect(await project.columns("customer")).toEqual(["created_by", "id"]);
      expect(await project.columns("stamped")).toBeNull();
    }));

  it("computed fields get no column and no migration, but do appear (read-only) in generated DTOs", () =>
    withProject({ dialect }, async (project) => {
      await project.writeConfig(
        [],
        `modules: [{ name: "people", models: [{
          name: "person",
          fields: {
            id: { type: "integer", required: true },
            first: { type: "char", required: true },
            last: { type: "char", required: true },
            fullName: { type: "char", depends: ["first", "last"], compute: (r) => r.first + " " + r.last,
                        search: (op, v) => [["first", op, v]] },
          } }] }],`
      );
      expect((await project.orm("sync")).code).toBe(0);
      expect(await project.columns("person")).toEqual(["first", "id", "last"]);
      expect((await project.orm("migrate:generate")).stdout).toMatch(/No changes detected/);

      // inspect:model reads the recorded metadata, which holds stored fields only
      expect((await project.orm("inspect:model person")).stdout).not.toContain("fullName");

      expect((await project.orm("generate:dto")).code).toBe(0);
      const schemas = JSON.parse(await project.read("dto/schemas.json"));
      expect(schemas.person.read.properties.fullName).toEqual({ type: "string", readOnly: true });
      expect(schemas.person.create.properties).not.toHaveProperty("fullName");
      expect(schemas.person.update.properties).not.toHaveProperty("fullName");
    }));
});

describe.each(eachCliDialect())("orm sequences:fix - $name", ({ name: dialect }) => {
  const postgres = dialect === "postgres";

  it("repairs a sequence that raw inserts left behind (Postgres), and is a harmless no-op on SQLite", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      await project.orm("sync");
      // Ids inserted behind the ORM's back - the auto-increment sequence never saw them.
      await project.db((db) => db("post").insert([{ id: 1, title: "a" }, { id: 2, title: "b" }, { id: 30, title: "c" }]));

      const first = await project.orm("sequences:fix");
      expect(first.code).toBe(0);
      if (postgres) {
        expect(first.stdout).toMatch(/synced 3 sequences: post, comment, tag/);
      } else {
        expect(first.stdout).toContain("Nothing to fix");
      }

      // The next auto-assigned id no longer collides.
      const inserted = await project.db(async (db) => {
        const [row] = await db("post").insert({ title: "auto" }).returning("id");
        return row.id ?? row;
      });
      expect(Number(inserted)).toBeGreaterThan(30);

      const again = await project.orm("sequences:fix");
      expect(again.code).toBe(0); // idempotent
    }));

  it("--json lists every model with whether its sequence was synced", () =>
    withProject({ dialect, models: BLOG }, async (project) => {
      await project.orm("sync");
      const { code, stdout } = await project.orm("sequences:fix --json");
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual(
        ["post", "comment", "tag"].map((model) => ({ model, table: model, synced: postgres }))
      );
    }));

  it("fails cleanly (exit 1) when the config declares no models", () =>
    withProject({ dialect, models: [] }, async (project) => {
      const { code, stderr } = await project.orm("sequences:fix");
      expect(code).toBe(1);
      expect(stderr).toMatch(/declares no models/);
    }));
});
