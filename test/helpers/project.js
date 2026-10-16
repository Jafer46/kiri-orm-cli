import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeConnection, createConnection } from "@kiri-orm/core";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../src/bin.js");

/** Spawns the real `orm` executable. Never rejects on a non-zero exit: the code is part of the result. */
export function runCli(args, { cwd, env = {} }) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

/** SQLite always; Postgres too when TEST_PG_CONNECTION_STRING is set. */
export function eachCliDialect() {
  const dialects = [{ name: "sqlite" }];
  if (process.env.TEST_PG_CONNECTION_STRING)
    dialects.push({ name: "postgres" });
  return dialects;
}

/**
 * A scratch project: a temp directory holding an `orm.config.mjs`, and
 * a database nothing else touches - a SQLite file inside that
 * directory, or a throwaway Postgres schema (dropped afterwards).
 *
 *   await withProject({ dialect, models }, async (project) => {
 *     const { code, stdout } = await project.orm("sync");
 *   });
 */
export async function withProject({ dialect, models = [] }, fn) {
  const dir = await mkdtemp(join(tmpdir(), "orm-cli-"));
  let connection;
  let cleanupDb = async () => {};

  if (dialect === "postgres") {
    const base = process.env.TEST_PG_CONNECTION_STRING;
    const schema = `t_${randomBytes(6).toString("hex")}`;
    const admin = createConnection({
      dialect: "postgres",
      connectionString: base,
    });
    await admin.raw(`create schema "${schema}"`);
    const url = new URL(base);
    url.searchParams.set("options", `-c search_path=${schema}`);
    connection = { dialect: "postgres", connectionString: url.toString() };
    cleanupDb = async () => {
      await admin.raw(`drop schema "${schema}" cascade`);
      await closeConnection(admin);
    };
  } else {
    connection = { dialect: "sqlite", filename: "./scratch.db" };
  }

  const project = {
    dir,
    connection,
    dialect,
    orm: (args, options = {}) =>
      runCli(Array.isArray(args) ? args : args.split(" "), {
        cwd: options.cwd ?? dir,
        env: options.env,
      }),
    /** (Re)writes the config. `extra` is spliced in as source, e.g. `migrationsDir: "db/migrations"`. */
    async writeConfig(nextModels = models, extra = "") {
      const resolved =
        dialect === "sqlite"
          ? { ...connection, filename: join(dir, "scratch.db") }
          : connection;
      await writeFile(
        join(dir, "orm.config.mjs"),
        `export default {\n  connection: ${JSON.stringify(resolved)},\n  models: ${JSON.stringify(nextModels, null, 2)},\n  ${extra}\n};\n`,
      );
    },
    /** Runs `fn(db)` on a direct connection to the scratch database, for asserting real schema state. */
    async db(callback) {
      const resolved =
        dialect === "sqlite"
          ? { ...connection, filename: join(dir, "scratch.db") }
          : connection;
      const knex = createConnection(resolved);
      try {
        return await callback(knex);
      } finally {
        await closeConnection(knex);
      }
    },
    columns: (table) =>
      project.db(async (db) =>
        (await db.schema.hasTable(table))
          ? Object.keys(await db(table).columnInfo()).sort()
          : null,
      ),
    read: (path) => readFile(join(dir, path), "utf8"),
    list: async (path) => readdir(join(dir, path)).catch(() => []),
    write: async (path, content) => {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    },
  };
  await project.writeConfig(models);

  try {
    return await fn(project);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await cleanupDb();
  }
}

export const invoice = (fields = {}, extra = {}) => ({
  name: "invoice",
  fields: { id: { type: "integer", required: true }, ...fields },
  ...extra,
});

export const BLOG = [
  {
    name: "post",
    fields: {
      id: { type: "integer", required: true },
      title: { type: "char", required: true, maxLength: 80, unique: true },
    },
    relations: {
      comments: { type: "hasMany", model: "comment", foreignKey: "postId" },
      tags: {
        type: "belongsToMany",
        model: "tag",
        through: "post_tag",
        foreignKey: "post_id",
        otherKey: "tag_id",
      },
    },
  },
  {
    name: "comment",
    fields: {
      id: { type: "integer", required: true },
      postId: { type: "integer", required: true },
      body: { type: "char" },
    },
  },
  {
    name: "tag",
    fields: {
      id: { type: "integer", required: true },
      name: { type: "char", required: true },
    },
  },
];
