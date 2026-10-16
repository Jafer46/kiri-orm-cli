import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const DIALECT = ["sqlite", "postgres"];

export default {
  name: "init",
  summary: "Initializes config file for the cli use",
  usage: "orm init [--filename <name>] [--dialect sqlite|postgres]",
  options: {
    filename: {
      type: "string",
      description: "Configuration file name. By default `orm.config.js`",
    },
    dialect: {
      type: "string",
      description: "Choose which dialect to use. Sqlite or Postgres",
    },
  },
  maxPositionals: 0,

  async run({ values, ctx }) {
    const cwd = ctx.cwd;
    const rl = createInterface({ input: stdin, output: stdout });

    const ask = async (question, defaultValue = "") => {
      const answer = await rl.question(
        `${question}${defaultValue ? ` (${defaultValue})` : ""}: `,
      );
      return answer.trim() || defaultValue;
    };

    const choose = async (question, choices, defaultValue) => {
      console.log(`\n${question}`);

      choices.forEach((choice, index) => {
        console.log(
          `  ${index + 1}. ${choice}${
            choice === defaultValue ? " (default)" : ""
          }`,
        );
      });

      while (true) {
        const answer = await ask(
          "Choose an option",
          String(choices.indexOf(defaultValue) + 1),
        );

        const index = Number(answer) - 1;

        if (Number.isInteger(index) && index >= 0 && index < choices.length) {
          return choices[index];
        }

        console.log("Please enter a valid option number.");
      }
    };

    try {
      console.log("\nWelcome to ORM!\n");

      const filename =
        values.filename ??
        (await ask("Configuration file name", "orm.config.js"));

      const file = join(cwd, filename);

      try {
        await access(file);

        const overwrite = await ask(
          `${filename} already exists. Overwrite? (y/N)`,
          "n",
        );

        if (!["y", "yes"].includes(overwrite.toLowerCase())) {
          console.log("Initialization cancelled.");
          return;
        }
      } catch {
        // Config file does not exist.
      }

      const dialect =
        values.dialect ??
        (await choose("Choose a database dialect", DIALECT, "sqlite"));

      if (!DIALECT.includes(dialect)) {
        throw new Error(
          `--dialect expects one of ${DIALECT.join(", ")}, got "${dialect}"`,
        );
      }

      let connection;

      if (dialect === "sqlite") {
        const dbFilename = await ask("SQLite database filename", "./app.db");

        connection = {
          dialect,
          filename: dbFilename,
        };
      } else {
        const connectionString = await ask("PostgreSQL connection string", "");

        connection = {
          dialect,
          connectionString,
        };
      }

      const models = await ask(
        "Where are your models located?",
        "./src/**/*.model.js",
      );

      const migrationsDir = await ask(
        "Where should migrations be stored?",
        "migrations",
      );

      const dtoDir = await ask("Where should DTOs be stored?", "dto");

      const connectionConfig =
        dialect === "sqlite"
          ? `dialect: "sqlite", filename: ${JSON.stringify(connection.filename)}`
          : `dialect: "postgres", connectionString: ${JSON.stringify(connection.connectionString)}`;

      const content = `export default {
  connection: { ${connectionConfig} },
  models: ${JSON.stringify(models)},
  migrationsDir: ${JSON.stringify(migrationsDir)},
  dtoDir: ${JSON.stringify(dtoDir)},
};
`;

      await writeFile(file, content, { flag: "w" });

      console.log(`\n✔ Created ${filename}`);
    } finally {
      rl.close();
    }
  },
};
