import { describe, expect, expectTypeOf, test } from "bun:test";

import { defineSchema, schema as yamlSchema } from "./index.ts";
import type {
  InferSchema,
  InferDatabase,
  Insertable,
  JSONValue,
  Selectable,
  Updateable,
} from "./index.ts";

const yaml = `
  _version: "1.0.0"
  _extends: [files]
  _files:
    attach_to: [posts]
    owner: false
  posts:
    id: id(bigint)
    title: string
    status: string enum=[draft,published] default="draft"
    score: decimal(10,2)?
    metadata: json?
    published_at: timestamp?
`;

type DB = InferDatabase<typeof yaml>;
type Post = Selectable<DB["posts"]>;
type NewPost = Insertable<DB["posts"]>;
type PostUpdate = Updateable<DB["posts"]>;

const interpolationIsRejected = (value: string) =>
  // @ts-expect-error Schema interpolation is intentionally unsupported.
  yamlSchema`_version: "1.0.0"\n${value}`;
void interpolationIsRejected;

describe("YAML schema type inference", () => {
  test("infers from a const string without an as const assertion", () => {
    const source = `
      _version: "1.0.0"
      notes:
        id: id
        body: string
    `;
    type ConstDB = InferDatabase<typeof source>;
    expectTypeOf<Selectable<ConstDB["notes"]>>().toEqualTypeOf<{
      id: string;
      body: string;
    }>();
  });

  test("infers select, insert, and update types", () => {
    expectTypeOf<Post["id"]>().toEqualTypeOf<string>();
    expectTypeOf<Post["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Post["status"]>().toEqualTypeOf<"draft" | "published">();
    expectTypeOf<Post["score"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Post["metadata"]>().toEqualTypeOf<JSONValue | null>();
    expectTypeOf<Post["published_at"]>().toEqualTypeOf<Date | null>();
    expectTypeOf<NewPost>().toMatchObjectType<{
      title: string;
    }>();
    expectTypeOf<NewPost["id"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NewPost["status"]>().toEqualTypeOf<
      "draft" | "published" | undefined
    >();
    expectTypeOf<PostUpdate["title"]>().toEqualTypeOf<string | undefined>();
  });

  test("infers file and attachment tables", () => {
    expectTypeOf<Selectable<DB["file"]>>().toEqualTypeOf<{
      id: string;
      key: string;
      name: string;
      type: string;
      size: number;
      createdAt: Date;
      updatedAt: Date;
    }>();
    expectTypeOf<
      Selectable<DB["posts_file"]>["entityId"]
    >().toEqualTypeOf<string>();
  });

  test("defineSchema carries the inferred database type", () => {
    const schema = defineSchema(yaml);
    type DefinedDB = InferSchema<typeof schema>;
    expectTypeOf<DefinedDB>().toEqualTypeOf<DB>();
    expect(schema.version).toBe("1.0.0");
  });

  test("preserves child indentation when top-level keys are unindented", () => {
    const authored = defineSchema(`
_version: "1.0.0"
notes:
  id: id
  body: string
`);
    expect(authored.source).toContain("\n  id: id\n");
    expect(authored.tables.notes?.columns.body?.kind).toBe("string");
  });

  test("dedents and parses interpolation-free schema tagged templates", () => {
    const tagged = yamlSchema`
      _version: "1.0.0"
      notes:
        id: id
        body: string
    `;
    type TaggedDB = InferSchema<typeof tagged>;
    expectTypeOf<TaggedDB>().toBeNever();
    expect(tagged.version).toBe("1.0.0");
    expect(tagged.source).toStartWith('_version: "1.0.0"');
    expect(tagged.source).toContain("notes:");
    const { notes } = tagged.tables;
    expect(notes).toBeDefined();
    if (!notes) {
      throw new Error("expected notes table");
    }
    const { body } = notes.columns;
    expect(body).toBeDefined();
    if (!body) {
      throw new Error("expected body column");
    }
    expect(body.kind).toBe("string");
  });

  test("rejects schema tagged-template interpolation at runtime", () => {
    expect(() => interpolationIsRejected("posts")).toThrow(
      "do not support interpolation"
    );
  });

  test("infers binary and ownerless file shapes", () => {
    const owned = `
      _version: "1.0.0"
      _extends: [files]
      _files:
        owner: false
        attach_to: [assets]
      assets:
        id: id
        blob: binary
    `;
    type FilesDB = InferDatabase<typeof owned>;
    expectTypeOf<
      Selectable<FilesDB["assets"]>["blob"]
    >().toEqualTypeOf<Uint8Array>();
    expectTypeOf<Selectable<FilesDB["file"]>>().toEqualTypeOf<{
      id: string;
      key: string;
      name: string;
      type: string;
      size: number;
      createdAt: Date;
      updatedAt: Date;
    }>();
  });

  test("infers bare reference column types from the target", () => {
    const source = `
      _version: "1.0.0"
      parents:
        id: id(bigint)
      children:
        id: id
        parent_id: references=parents.id
    `;
    type RefDB = InferDatabase<typeof source>;
    expectTypeOf<
      Selectable<RefDB["children"]>["parent_id"]
    >().toEqualTypeOf<string>();
  });
});
