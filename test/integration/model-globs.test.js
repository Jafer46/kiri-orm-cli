import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { eachCliDialect, withProject } from "../helpers/project.js";

// Model files live in a temp project, so they import core by URL (resolved from the CLI package,
// i.e. the very copy the CLI itself loads) rather than by name.
// (realpath: node follows the workspace symlink, so this is the same module instance the CLI imports.)
const CORE = pathToFileURL(
  realpathSync(createRequire(import.meta.url).resolve("@kiri-orm/core")),
).href;

const model = (name, { fields = "", relations = "" } = {}) =>
  `import { createModel } from "${CORE}";
export const ${name[0].toUpperCase() + name.slice(1)} = createModel("${name}", {
  fields: { id: { type: "integer", required: true }${fields} },
  ${relations ? `relations: { ${relations} },` : ""}
});
`;

describe.each(eachCliDialect())(
  "orm with `models` as globs - $name",
  ({ name: dialect }) => {
    it("sync finds the model files itself: nothing in the config lists a model", () =>
      withProject(
        { dialect, models: ["./models/**/*.model.js"] },
        async (project) => {
          await project.write(
            "models/user.model.js",
            model("user", {
              fields: `, email: { type: "char", required: true }`,
            }),
          );
          await project.write(
            "models/blog/post.model.js",
            model("post", {
              fields: `, authorId: { type: "integer" }`,
              relations: `author: { type: "belongsTo", model: "user", foreignKey: "authorId" }`,
            }),
          );
          await project.write(
            "models/blog/helper.js",
            `throw new Error("not a model file - must not be loaded");`,
          );

          const { code, stdout } = await project.orm("sync");
          expect(code).toBe(0);
          expect(stdout).toContain("Synced 2 models");
          expect(await project.columns("user")).toEqual(["email", "id"]);
          expect(await project.columns("post")).toEqual(["author_id", "id"]);
        },
      ));

    it("a new model file is picked up by the next run with no config change", () =>
      withProject(
        { dialect, models: ["./models/*.model.js"] },
        async (project) => {
          await project.write("models/user.model.js", model("user"));
          expect((await project.orm("sync")).code).toBe(0);
          expect(await project.columns("tag")).toBeNull();

          await project.write("models/tag.model.js", model("tag"));
          const { code, stdout } = await project.orm("sync");
          expect(code).toBe(0);
          expect(stdout).toContain("created tables: tag");
        },
      ));

    it("an extension in one file applies to a model defined in another, whichever loads first", () =>
      withProject(
        { dialect, models: ["./modules/*/*.js"] },
        async (project) => {
          await project.write(
            "modules/a-extra/extend.js",
            `import { extendModel } from "${CORE}";\nextendModel("user", { fields: { nickname: { type: "char" } } });\n`,
          );
          await project.write("modules/z-base/user.js", model("user"));

          expect((await project.orm("sync")).code).toBe(0);
          expect(await project.columns("user")).toEqual(["id", "nickname"]);
        },
      ));

    it("`!` globs exclude files", () =>
      withProject(
        { dialect, models: ["./models/*.js", "!./models/index.js"] },
        async (project) => {
          await project.write("models/user.js", model("user"));
          await project.write(
            "models/index.js",
            `throw new Error("index.js must be excluded");`,
          );
          expect((await project.orm("sync")).code).toBe(0);
        },
      ));

    it("migrate:generate, generate:dto and inspect:model all see the discovered models", () =>
      withProject({ dialect, models: ["./models/*.js"] }, async (project) => {
        await project.write(
          "models/user.js",
          model("user", { fields: `, name: { type: "char" }` }),
        );

        const generated = await project.orm("migrate:generate --dry-run");
        expect(generated.code).toBe(0);
        expect(generated.stdout).toMatch(/user/);

        const dto = await project.orm("generate:dto");
        expect(dto.code).toBe(0);
        expect(
          JSON.parse(await project.read("dto/schemas.json")),
        ).toHaveProperty("user");

        await project.orm("sync");
        const inspected = await project.orm("inspect:model user");
        expect(inspected.code).toBe(0);
        expect(inspected.stdout).toContain("name");
      }));

    it("a config can still list createModel() results directly (they live in the global registry)", () =>
      withProject({ dialect, models: [] }, async (project) => {
        await project.write(
          "models/user.js",
          model("user", { fields: `, name: { type: "char" }` }),
        );
        await project.write(
          "orm.config.mjs",
          `import { User } from "./models/user.js";\nexport default { connection: ${JSON.stringify({ dialect: "sqlite", filename: "./scratch.db" })}, models: [User] };\n`,
        );
        if (dialect !== "sqlite") return; // the hand-written config above is SQLite-only
        const { code, stdout } = await project.orm("sync");
        expect(code).toBe(0);
        expect(stdout).toContain("Synced 1 model");
      }));

    it("exits 1 naming the pattern when a glob matches nothing", () =>
      withProject(
        { dialect, models: ["./models/*.model.js"] },
        async (project) => {
          const { code, stderr } = await project.orm("sync");
          expect(code).toBe(1);
          expect(stderr).toMatch(
            /no files matched "\.\/models\/\*\.model\.js"/,
          );
        },
      ));

    it("exits 1 naming the file when a model file fails to load", () =>
      withProject({ dialect, models: ["./models/*.js"] }, async (project) => {
        await project.write("models/broken.js", `throw new Error("boom");`);
        const { code, stderr } = await project.orm("sync");
        expect(code).toBe(1);
        expect(stderr).toMatch(/broken\.js: boom/);
      }));

    it("exits 1 with a hint when the matched files register no model", () =>
      withProject({ dialect, models: ["./models/*.js"] }, async (project) => {
        await project.write("models/plain.js", `export const x = 1;`);
        const { code, stderr } = await project.orm("sync");
        expect(code).toBe(1);
        expect(stderr).toMatch(/none registered a model/);
      }));

    it("refuses namingStrategy/fieldTypeRegistry alongside globs rather than silently ignoring them", () =>
      withProject({ dialect, models: ["./models/*.js"] }, async (project) => {
        await project.write("models/user.js", model("user"));
        await project.writeConfig(["./models/*.js"], "namingStrategy: {}");
        const { code, stderr } = await project.orm("sync");
        expect(code).toBe(1);
        expect(stderr).toMatch(/namingStrategy/);
      }));
  },
);
