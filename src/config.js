import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getDefaultModelRegistry,
  loadModels,
  ModelRegistry,
} from "@kiri-orm/core";
import { CliError } from "./errors.js";

export const CONFIG_FILE_NAMES = [
  "orm.config.js",
  "orm.config.mjs",
  "orm.config.cjs",
];

/**
 * @typedef {Object} OrmConfig - what `orm.config.js` exports (as the default export, or as a function returning it)
 * @property {import('@kiri-orm/core').ConnectionConfig} connection - `{ dialect: "sqlite", filename }` or `{ dialect: "postgres", connectionString }`
 * @property {string|Array<string|object>} [models] - a glob (or array of globs) of files that define models
 *   with createModel()/extendModel()/defineMixin(), e.g. `"./src/**\/*.model.js"`; or model definitions, as for
 *   createClient(); or createModel() results. Globs resolve against the config file's directory; a `!`-prefixed
 *   glob excludes. Globs and createModel() results use the global API's registry; plain definitions don't need it.
 * @property {Array<{ models: object[] }>} [modules] - defineModule() results, as for createClient()
 * @property {import('@kiri-orm/core').ModelRegistry} [registry] - an already-built registry, instead of `models`/`modules`
 * @property {object} [namingStrategy]
 * @property {object} [fieldTypeRegistry]
 * @property {object} [columnBuilderRegistry]
 * @property {string} [migrationsDir] - default "./migrations"
 * @property {string} [dtoDir] - default "./dto"
 */

/**
 * Finds and loads the config. Relative paths in it (`migrationsDir`,
 * `dtoDir`, a SQLite `filename`) are resolved against the config
 * file's own directory - not the shell's - so `orm` behaves the same
 * from any subdirectory of the project.
 *
 * @param {{ cwd: string, configPath?: string, env?: NodeJS.ProcessEnv }} options
 */
export async function loadConfig({ cwd, configPath, env = process.env }) {
  let file;
  if (configPath) {
    file = resolve(cwd, configPath);
    if (!existsSync(file)) throw new CliError(`Config file not found: ${file}`);
  } else {
    file = CONFIG_FILE_NAMES.map((name) => resolve(cwd, name)).find(
      (candidate) => existsSync(candidate),
    );
    if (!file) {
      throw new CliError(
        `No config file found in ${cwd} (looked for ${CONFIG_FILE_NAMES.join(", ")}). ` +
          `Create one that exports { connection, models }, or pass --config <path>.`,
      );
    }
  }

  let raw;
  try {
    const mod = await import(pathToFileURL(file).href);
    raw = mod.default ?? mod.config ?? mod;
    if (typeof raw === "function") raw = await raw({ env });
  } catch (error) {
    throw new CliError(`Could not load config ${file}: ${error.message}`);
  }
  if (raw === null || typeof raw !== "object") {
    throw new CliError(
      `Config ${file} must export an object (or a function returning one).`,
    );
  }

  const dir = dirname(file);
  const inDir = (path) => (isAbsolute(path) ? path : resolve(dir, path));

  const entries =
    raw.models == null
      ? []
      : Array.isArray(raw.models)
        ? raw.models
        : [raw.models];
  const globs = entries.filter((entry) => typeof entry === "string");
  const handles = entries.filter(isModelHandle);
  const definitions = entries.filter(
    (entry) => typeof entry !== "string" && !isModelHandle(entry),
  );

  // Model files register themselves into the global registry as they load - that's the point of
  // this mode: nothing here lists models, the files are found.
  let modelFiles = [];
  if (globs.length > 0) {
    try {
      modelFiles = await loadModels(globs, { cwd: dir });
    } catch (error) {
      throw new CliError(`Could not load models for ${file}: ${error.message}`);
    }
  }

  let connection = raw.connection;
  if (
    connection?.dialect === "sqlite" &&
    connection.filename &&
    connection.filename !== ":memory:"
  ) {
    connection = { ...connection, filename: inDir(connection.filename) };
  }

  return {
    file,
    dir,
    connection,
    models: definitions,
    modelFiles,
    // True when models come from files/createModel() handles, i.e. live in the global registry.
    useGlobalRegistry: globs.length > 0 || handles.length > 0,
    modules: raw.modules ?? [],
    registry: raw.registry,
    namingStrategy: raw.namingStrategy,
    fieldTypeRegistry: raw.fieldTypeRegistry,
    columnBuilderRegistry: raw.columnBuilderRegistry,
    migrationsDir: inDir(raw.migrationsDir ?? "migrations"),
    dtoDir: inDir(raw.dtoDir ?? "dto"),
  };
}

/**
 * The model registry described by the config, or null if it declares
 * no models at all (fine for commands that only read the database).
 */
export function buildRegistry(config) {
  if (config.registry) return config.registry;
  if (config.useGlobalRegistry) return buildGlobalRegistry(config);
  if (
    config.models.length === 0 &&
    config.modules.every((mod) => mod.models.length === 0)
  )
    return null;

  const registry = new ModelRegistry({
    namingStrategy: config.namingStrategy,
    fieldTypeRegistry: config.fieldTypeRegistry,
  });
  try {
    for (const model of config.models) registry.define(model);
    // Each module's models are attributed to it, so errors and `origins` can say who added what.
    // Order doesn't matter: a module may extend a model another module defines, whichever loads first.
    for (const mod of config.modules)
      for (const model of mod.models)
        registry.define(model, { origin: mod.name });
    registry.assertResolved();
  } catch (error) {
    throw new CliError(`Invalid model in ${config.file}: ${error.message}`);
  }
  return registry;
}

/**
 * createModel() returns a handle (`{ name, schema, find, ... }`), not a definition: it has no
 * `fields` of its own. Recognised so a config can list them directly. Checked with `in` so the
 * `schema` getter - which throws for a model still waiting on a mixin - is never invoked.
 */
function isModelHandle(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    typeof entry.name === "string" &&
    entry.fields === undefined &&
    "schema" in entry
  );
}

/**
 * Models defined with createModel() already live in the global registry, so the CLI uses that one
 * rather than building a second registry that could drift from it. Plain definitions or modules in
 * the same config are added to it.
 */
function buildGlobalRegistry(config) {
  if (config.namingStrategy || config.fieldTypeRegistry) {
    throw new CliError(
      `${config.file}: \`namingStrategy\` / \`fieldTypeRegistry\` can't be applied to models defined with createModel() ` +
        `(the global registry is already built). Remove them, or list plain model definitions instead of globs.`,
    );
  }
  const registry = getDefaultModelRegistry();
  try {
    for (const model of config.models) registry.define(model);
    for (const mod of config.modules)
      for (const model of mod.models)
        registry.define(model, { origin: mod.name });
    registry.assertResolved();
  } catch (error) {
    throw new CliError(`Invalid model in ${config.file}: ${error.message}`);
  }
  if (
    config.modelFiles.length > 0 &&
    registry.listModels().length === 0 &&
    registry.listAbstract().length === 0
  ) {
    throw new CliError(
      `Loaded ${config.modelFiles.length} file(s) matching \`models\` in ${config.file}, but none registered a model. ` +
        `They must call createModel() from the same installed copy of @kiri-orm/core the CLI uses.`,
    );
  }
  return registry;
}
