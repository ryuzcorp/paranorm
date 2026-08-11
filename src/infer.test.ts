import { describe, expect, expectTypeOf, test } from "bun:test";

import type { Insertable, Kysely, Selectable, Updateable } from "kysely";

import {
  defineSchema,
  type InferSchema,
  type InferDatabase,
  type JSONValue,
  schema as yamlSchema,
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
` as const;

type DB = InferDatabase<typeof yaml>;
type Post = Selectable<DB["posts"]>;
type NewPost = Insertable<DB["posts"]>;
type PostUpdate = Updateable<DB["posts"]>;

// Compile-only integration: inferred table and column names flow through Kysely.
function kyselyQueries(db: Kysely<DB>) {
  void db.selectFrom("posts").select(["posts.id", "posts.title"]).where("status", "=", "published");
  void db.insertInto("posts").values({ author_id: "user-id", title: "Hello" });
  void db.updateTable("posts").set({ published_at: new Date() }).where("id", "=", "42");
}
void kyselyQueries;

function interpolationIsRejected(value: string) {
  // @ts-expect-error Schema interpolation is intentionally unsupported.
  return yamlSchema`_version: "1.0.0"\n${value}`;
}
void interpolationIsRejected;

describe("YAML schema type inference", () => {
  test("infers Kysely select, insert, and update types", () => {
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
    expectTypeOf<NewPost["status"]>().toEqualTypeOf<"draft" | "published" | undefined>();
    expectTypeOf<PostUpdate["title"]>().toEqualTypeOf<string | undefined>();
  });

  test("infers auth, API-key, file, and attachment tables", () => {
    expectTypeOf<Selectable<DB["user"]>["banned"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Selectable<DB["user"]>["role"]>().toEqualTypeOf<"user" | "admin">();
    expectTypeOf<Selectable<DB["apikey"]>["requestCount"]>().toEqualTypeOf<number>();
    expectTypeOf<Selectable<DB["file"]>["userId"]>().toEqualTypeOf<string>();
    expectTypeOf<Selectable<DB["posts_file"]>["entityId"]>().toEqualTypeOf<string>();
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
    expect(tagged.tables.notes!.columns.body!.kind).toBe("string");
  });
});
