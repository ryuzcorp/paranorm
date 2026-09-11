import { describe, expect, test } from "bun:test";

import { parseColumn, parseSchema, SchemaValidationError } from "./index.ts";

describe("parseColumn", () => {
  test("parses id variants and generation", () => {
    expect(parseColumn("id", "id")).toMatchObject({
      dataType: "varchar(255)",
      generation: "cuid",
      kind: "id",
      primaryKey: true,
    });
    expect(parseColumn("id", "id(bigint)")).toMatchObject({
      dataType: "bigint",
      generation: "auto-increment",
      kind: "id",
    });
    expect(parseColumn("id", "id(uuidv4)")).toMatchObject({
      dataType: "uuid",
      generation: "uuidv4",
      kind: "id",
    });
  });

  test("parses defaults, flags, and referential actions", () => {
    expect(parseColumn("created", "timestamp default=now")).toMatchObject({
      default: { kind: "keyword", value: "now" },
    });
    expect(
      parseColumn("flag", "boolean default=true unique index")
    ).toMatchObject({
      default: { kind: "literal", value: true },
      index: true,
      unique: true,
    });
    expect(parseColumn("flag", "boolean default=false")).toMatchObject({
      default: { kind: "literal", value: false },
    });
    expect(
      parseColumn("stamp", `timestamp default=sql("datetime('now')")`)
    ).toMatchObject({
      default: { kind: "sql", value: "datetime('now')" },
    });
    expect(
      parseColumn(
        "parent_id",
        "string references=nodes.id on_delete=cascade on_update=restrict index"
      )
    ).toMatchObject({
      index: true,
      references: {
        column: "id",
        onDelete: "cascade",
        onUpdate: "restrict",
        table: "nodes",
      },
    });
  });

  test("parses enum and composite unique modifiers", () => {
    expect(
      parseColumn("status", 'string enum=[draft, published] default="draft"')
    ).toMatchObject({
      default: { kind: "literal", value: "draft" },
      enumValues: ["draft", "published"],
    });
    expect(
      parseColumn("slug", "string unique=[posts.project_id, posts.slug]")
    ).toMatchObject({
      compositeUnique: ["posts.project_id", "posts.slug"],
    });
  });

  test("rejects unbalanced tokens and empty enums", () => {
    expect(() => parseColumn("bad", "string enum=[a")).toThrow("unbalanced");
    expect(() => parseColumn("bad", "string enum=[]")).toThrow(
      "enum must not be empty"
    );
    expect(() => parseColumn("bad", "string unique=[posts.only]")).toThrow(
      "composite unique needs at least two columns"
    );
    expect(() => parseColumn("bad", "string unknown=yes")).toThrow(
      "unsupported modifier"
    );
    expect(() => parseColumn("bad", "string on_delete=cascade")).toThrow(
      "must follow references"
    );
    expect(() =>
      parseColumn("bad", "string references=nodes.id on_delete=explode")
    ).toThrow("invalid on_delete");
  });
});

describe("parseSchema validation", () => {
  test("infers bare references column type from target", () => {
    const schema = parseSchema(`
_version: "1.0.0"
parents:
  id: id(bigint)
children:
  id: id
  parent_id: references=parents.id
`);
    expect(schema.tables.children?.columns.parent_id).toMatchObject({
      dataType: "bigint",
      kind: "id",
      references: { column: "id", table: "parents" },
    });
  });

  test("accepts object-form schema documents", () => {
    const schema = parseSchema({
      _version: "1.0.0",
      notes: { body: "string", id: "id" },
    });
    expect(schema.version).toBe("1.0.0");
    expect(schema.tables.notes?.columns.body?.kind).toBe("string");
  });

  test("accepts custom macros", () => {
    const schema = parseSchema(`_version: "1.0.0"\n_extends: [widgets]\n`, {
      macros: {
        widgets: () => ({
          widget: { id: "id", label: "string" },
        }),
      },
    });
    expect(schema.tables.widget?.columns.label?.kind).toBe("string");
  });

  test("rejects foreign-key cycles", () => {
    expect(() =>
      parseSchema(`
_version: "1.0.0"
a:
  id: id
  b_id: string references=b.id
b:
  id: id
  a_id: string references=a.id
`)
    ).toThrow("foreign key cycle");
  });

  test("rejects has_many without reverse belongs_to", () => {
    expect(() =>
      parseSchema(`
_version: "1.0.0"
parents:
  id: id
  _relations:
    kids: has_many=children
children:
  id: id
`)
    ).toThrow("no reverse belongs_to");
  });

  test("rejects ambiguous belongs_to foreign keys", () => {
    expect(() =>
      parseSchema(`
_version: "1.0.0"
parents:
  id: id
children:
  id: id
  left_id: string references=parents.id
  right_id: string references=parents.id
  _relations:
    parent: belongs_to=parents
`)
    ).toThrow("exactly one foreign key");
  });

  test("rejects redefining extension tables and unknown extensions", () => {
    expect(() =>
      parseSchema(`
_version: "1.0.0"
_extends: [idempotency]
paranorm_idempotency:
  key: id
`)
    ).toThrow("cannot be redefined");
    expect(() => parseSchema(`_version: "1.0.0"\n_extends: [nope]\n`)).toThrow(
      "unknown extension"
    );
    expect(() =>
      parseSchema(`_version: "1.0.0"\n_extends: [files]\nthings:\n  id: id\n`)
    ).toThrow("requires _files config");
  });

  test("rejects invalid access metadata", () => {
    expect(() =>
      parseSchema(`
_version: "1.0.0"
things:
  id: id
  _access:
    list: secret
`)
    ).toThrow("invalid policy");
    expect(() =>
      parseSchema(`
_version: "1.0.0"
things:
  id: id
  owner_id: string
  _access:
    update: owner
    owner_column: missing
`)
    ).toThrow("must name an existing column");
    expect(() =>
      parseSchema(`
_version: "1.0.0"
things:
  id: id
  _access:
    list: public
    weird: public
`)
    ).toThrow("unknown key");
  });

  test("rejects invalid composite unique members", () => {
    expect(() =>
      parseSchema(`
_version: "1.0.0"
posts:
  id: id
  slug: string unique=[posts.slug, other.title]
`)
    ).toThrow("invalid composite unique member");
    expect(() =>
      parseSchema(`
_version: "1.0.0"
posts:
  id: id
  project_id: string
  slug: string unique=[posts.project_id, posts.title]
`)
    ).toThrow("invalid composite unique member");
    expect(() =>
      parseSchema(`
_version: "1.0.0"
posts:
  id: id
  project_id: string
  slug: string unique=[other.project_id, other.slug]
`)
    ).toThrow("invalid composite unique member");
  });

  test("accepts composite unique declared on either member column", () => {
    const schema = parseSchema(`
_version: "1.0.0"
posts:
  id: id
  project_id: string unique=[posts.project_id, posts.slug]
  slug: string
`);
    expect(schema.tables.posts?.uniqueConstraints).toEqual([
      ["project_id", "slug"],
    ]);
  });

  test("rejects composite unique that omits the declaring column", () => {
    expect(() =>
      parseSchema(`
_version: "1.0.0"
posts:
  id: id
  project_id: string
  slug: string
  title: string unique=[posts.project_id, posts.slug]
`)
    ).toThrow("must include itself");
  });

  test("rejects invalid versions", () => {
    expect(() => parseSchema(`_version: "1.0"\nthings:\n  id: id\n`)).toThrow(
      "semver"
    );
    expect(() => parseSchema(`things:\n  id: id\n`)).toThrow("_version");
  });

  test("wraps string schema errors with source locations", () => {
    try {
      parseSchema(
        `_version: "1.0.0"\nthings:\n  id: id\n  bad: string enum=[]\n`,
        { sourceName: "app.yaml" }
      );
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      if (!(error instanceof SchemaValidationError)) {
        throw error;
      }
      expect(error.path).toBe("things.bad");
      expect(error.line).toBe(4);
      expect(error.column).toBe(3);
      expect(String(error)).toContain("app.yaml:4:3");
    }
  });

  test("reports path for object-form schema errors", () => {
    try {
      parseSchema(
        {
          _version: "1.0.0",
          entries: {
            author_id: "references=missing.id",
            id: "id",
          },
        },
        { sourceName: "app.json" }
      );
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      if (!(error instanceof SchemaValidationError)) {
        throw error;
      }
      expect(error.path).toBe("entries.author_id");
      expect(error.line).toBeUndefined();
      expect(error.column).toBeUndefined();
      expect(String(error)).toContain("app.json:entries.author_id");
    }
  });

  test("recovers locations from sourceText on object input", () => {
    const sourceText = `{
  "_version": "1.0.0",
  "entries": {
    "id": "id",
    "author_id": "references=missing.id"
  }
}`;
    try {
      parseSchema(
        {
          _version: "1.0.0",
          entries: {
            author_id: "references=missing.id",
            id: "id",
          },
        },
        {
          sourceName: "app.json",
          sourceText,
        }
      );
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      if (!(error instanceof SchemaValidationError)) {
        throw error;
      }
      expect(error.path).toBe("entries.author_id");
      expect(error.line).toBe(5);
      expect(String(error)).toContain("app.json:5:");
    }
  });

  test("locates JSON string schema errors by path", () => {
    const sourceText = `{
  "_version": "1.0.0",
  "entries": {
    "id": "id",
    "author_id": "references=missing.id"
  }
}`;
    try {
      parseSchema(sourceText, { sourceName: "app.json" });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      if (!(error instanceof SchemaValidationError)) {
        throw error;
      }
      expect(error.path).toBe("entries.author_id");
      expect(error.line).toBe(5);
      expect(String(error)).toContain("app.json:5:");
    }
  });

  test("prefers exact path over shorter key matches", () => {
    try {
      parseSchema(
        `_version: "1.0.0"
users:
  id: id
posts:
  id: id
  user_id: references=users.id
  author_id: references=missing.id
`,
        { sourceName: "cms.yaml" }
      );
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      if (!(error instanceof SchemaValidationError)) {
        throw error;
      }
      expect(error.path).toBe("posts.author_id");
      expect(error.line).toBe(7);
      expect(String(error)).toContain("cms.yaml:7:3");
    }
  });
});
