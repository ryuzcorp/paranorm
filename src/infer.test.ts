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
  _extends: [auth, files]
  _auth:
    roles: [user, admin]
    api_keys: true
  _files:
    attach_to: [posts]
  posts:
    id: id(bigint)
    author_id: references=user.id
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
    expectTypeOf<Post["author_id"]>().toEqualTypeOf<string>();
    expectTypeOf<Post["status"]>().toEqualTypeOf<"draft" | "published">();
    expectTypeOf<Post["score"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Post["metadata"]>().toEqualTypeOf<JSONValue | null>();
    expectTypeOf<Post["published_at"]>().toEqualTypeOf<Date | null>();
    expectTypeOf<NewPost>().toMatchObjectType<{
      title: string;
      author_id: string;
    }>();
    expectTypeOf<NewPost["id"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NewPost["status"]>().toEqualTypeOf<
      "draft" | "published" | undefined
    >();
    expectTypeOf<PostUpdate["title"]>().toEqualTypeOf<string | undefined>();
  });

  test("infers auth, API-key, file, and attachment tables", () => {
    expectTypeOf<Selectable<DB["user"]>["banned"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Selectable<DB["user"]>["role"]>().toEqualTypeOf<
      "user" | "admin"
    >();
    expectTypeOf<
      Selectable<DB["apikey"]>["requestCount"]
    >().toEqualTypeOf<number>();
    expectTypeOf<Selectable<DB["file"]>["userId"]>().toEqualTypeOf<string>();
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
});
