# @kiri-orm/cli

The `orm` command line for [kiri-orm](https://www.npmjs.com/package/@kiri-orm/core): create tables,
generate and run migrations, inspect models and generate DTOs, without your app running.

## Install

```bash
npm install --save-dev @kiri-orm/cli
npm install @kiri-orm/core better-sqlite3   # or: pg
```

The CLI needs the same database driver your app uses.

## Configure

Create `orm.config.js` next to your `package.json`:

```js
export default {
  connection: { dialect: "sqlite", filename: "./app.db" },
  // or: { dialect: "postgres", connectionString: process.env.DATABASE_URL }
  models: "./src/**/*.model.js", // glob(s) of the files that define your models
  migrationsDir: "migrations", // default
  dtoDir: "dto", // default
};
```

`models` is a glob (or an array of globs, with `!` to exclude) of files that call `createModel()`.
Globs resolve against the config file's directory. Use `-c, --config <path>` for a different file.

## Commands

| Command                | What it does                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `orm init`             | Creates a config file by using specific steps, like npm init.                          |
| `orm sync`             | Create missing tables and columns, and refresh the recorded schema metadata            |
| `orm migrate:generate` | Diff your models against the recorded schema and write a migration file                |
| `orm migrate:up`       | Apply pending migrations, oldest first                                                 |
| `orm migrate:down`     | Roll back the most recent migration (`--steps n` or `--all` for more)                  |
| `orm inspect:model`    | Show a model's table, fields and relations from the recorded metadata                  |
| `orm generate:dto`     | Write JSON Schemas (create / update / read) and JSDoc types generated from your models |
| `orm sequences:fix`    | Move each Postgres auto-increment sequence past the ids already in its table           |

Useful options:

- `orm migrate:generate --dry-run` previews the migration without writing it.
- `orm migrate:generate --allow-destructive` permits drops, which are otherwise never generated.
- `orm sync --add-missing-foreign-keys` adds foreign keys that tables created before foreign keys existed
  lack. It fails, naming the constraint, if existing rows already violate it.

Run `orm <command> --help` for every option. Exit codes: `0` success, `1` the command failed,
`2` the command line was wrong.

## Documentation

See the kiri-orm docs: https://kiri-orm.vercel.app

## License

See [LICENSE](./LICENSE).
