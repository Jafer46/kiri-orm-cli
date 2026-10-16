import { describe, it, expect } from "vitest";
import { eachCliDialect, withProject } from "../helpers/project.js";

const models = [
  { name: "author", fields: { id: { type: "integer", required: true } } },
  {
    name: "post",
    fields: {
      id: { type: "integer", required: true },
      authorId: { type: "integer", required: true },
    },
    relations: {
      author: { type: "belongsTo", model: "author", foreignKey: "authorId" },
    },
  },
];

const foreignKeys = (project, table) =>
  project.db(async (db) => {
    const { listForeignKeys } = await import("@kiri-orm/core");
    return (await listForeignKeys(db, table)).map(
      (k) => `${k.column}->${k.refTable}`,
    );
  });

describe.each(eachCliDialect())(
  "orm sync and foreign keys - $name",
  ({ name: dialect }) => {
    it("creates a real foreign key for every belongsTo and lists it", () =>
      withProject({ dialect, models }, async (project) => {
        const { code, stdout } = await project.orm("sync");
        expect(code).toBe(0);
        expect(stdout).toContain("foreign key:    post.author_id -> author.id");
        expect(await foreignKeys(project, "post")).toEqual([
          "author_id->author",
        ]);
      }));

    it("warns about a table that predates foreign keys, and --add-missing-foreign-keys fixes it", () =>
      withProject({ dialect, models }, async (project) => {
        await project.db(async (db) => {
          await db.schema.createTable("author", (t) =>
            t.integer("id").primary(),
          );
          await db.schema.createTable("post", (t) => {
            t.integer("id").primary();
            t.integer("author_id").notNullable();
          });
        });

        const warned = await project.orm("sync");
        expect(warned.code).toBe(0);
        expect(warned.stderr).toMatch(
          /warning: post\.author_id -> author\.id has no foreign key/,
        );

        const fixed = await project.orm("sync --add-missing-foreign-keys");
        expect(fixed.code).toBe(0);
        expect(fixed.stdout).toContain(
          "foreign key:    post.author_id -> author.id",
        );
        expect(await foreignKeys(project, "post")).toEqual([
          "author_id->author",
        ]);
      }));
  },
);
