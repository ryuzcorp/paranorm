import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, expectTypeOf, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

import { type Generated, paranorm, ParanOrmError } from "./index.ts";

interface DB {
  author: { id: Generated<number>; name: string; email: string };
  post: { id: Generated<number>; title: string; body: string | null; authorId: number };
  tag: { id: Generated<number>; name: string };
  post_tag: { postId: number; tagId: number };
}

function sqliteLayer(filename = ":memory:") {
  return SqliteClient.layer({ filename, disableWAL: true }) as Layer.Layer<
    SqlClient | SqliteClient.SqliteClient
  >;
}

function run<A, E>(
  effect: Effect.Effect<A, E, SqlClient>,
  layer: Layer.Layer<SqlClient | SqliteClient.SqliteClient> = sqliteLayer(),
) {
  return Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
}

function createSchema() {
  return Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient;
    yield* sql`
      CREATE TABLE author (
        id integer primary key autoincrement,
        name text not null,
        email text not null unique
      )
    `;
    yield* sql`
      CREATE TABLE post (
        id integer primary key autoincrement,
        title text not null,
        body text,
        authorId integer not null
      )
    `;
    yield* sql`
      CREATE TABLE tag (
        id integer primary key autoincrement,
        name text not null
      )
    `;
    yield* sql`
      CREATE TABLE post_tag (
        postId integer not null,
        tagId integer not null
      )
    `;
  });
}

describe("ParanOrm", () => {
  const query = paranorm<DB>();
  const dbFile = join(mkdtempSync(join(tmpdir(), "paranorm-")), "shared.db");
  const shared = sqliteLayer(dbFile);
  let aliceId: number;
  let firstPostId: number;

  beforeAll(async () => {
    await run(
      Effect.gen(function* () {
        yield* createSchema();
        const sql = yield* SqliteClient.SqliteClient;
        const authors = yield* sql<{ id: number }>`
          INSERT INTO author ${sql
            .insert([
              { name: "Alice", email: "alice@acme.com" },
              { name: "Bob", email: "bob@example.com" },
            ])
            .returning("id")}
        `;
        aliceId = authors[0]!.id;
        const posts = yield* sql<{ id: number }>`
          INSERT INTO post ${sql
            .insert([
              { title: "First", body: null, authorId: aliceId },
              { title: "Second", body: "text", authorId: aliceId },
              { title: "Bob post", body: null, authorId: authors[1]!.id },
            ])
            .returning("id")}
        `;
        firstPostId = posts[0]!.id;
        const tags = yield* sql<{ id: number }>`
          INSERT INTO tag ${sql.insert([{ name: "ts" }, { name: "sql" }]).returning("id")}
        `;
        yield* sql`
          INSERT INTO post_tag ${sql.insert(
            tags.map((tag) => ({ postId: firstPostId, tagId: tag.id })),
          )}
        `;
      }),
      shared,
    );
  });

  test("creates typed models implicitly from SqlClient", async () => {
    const alice = await run(query.author.findFirst({ where: { email: "alice@acme.com" } }), shared);
    expect(alice?.name).toBe("Alice");
    expect(await run(query.post.count(), shared)).toBe(3);
  });

  test("finds, filters, orders, and selects", async () => {
    const rows = await run(
      query.author.findMany({
        where: { OR: [{ name: { startsWith: "Ali" } }, { email: { endsWith: "example.com" } }] },
        orderBy: [{ name: "asc" }],
        select: { id: true, name: true },
      }),
      shared,
    );
    expectTypeOf(rows).toEqualTypeOf<Array<{ id: number; name: string }>>();
    expect(rows.map((row) => row.name)).toEqual(["Alice", "Bob"]);
    expect(rows[0]).not.toHaveProperty("email");
  });

  test("creates, updates, upserts, and deletes with inferred types", async () => {
    await run(
      Effect.gen(function* () {
        yield* createSchema();
        const alice = yield* query.author.create({
          data: { name: "Alice", email: "alice@example.com" },
        });
        expectTypeOf(alice).toEqualTypeOf<{ id: number; name: string; email: string }>();

        const created = yield* query.author.createMany({
          data: [
            { name: "Bob", email: "bob@example.com" },
            { name: "Carol", email: "carol@example.com" },
          ],
        });
        expect(created).toHaveLength(2);

        const updated = yield* query.author.update({
          where: { id: alice.id },
          data: { name: "Alicia" },
        });
        expect(updated.name).toBe("Alicia");
        expect(yield* query.author.updateMany({ data: { name: "Member" } })).toBe(3);

        const upserted = yield* query.author.upsert({
          where: { email: "alice@example.com" },
          create: { name: "Unused", email: "alice@example.com" },
          update: { name: "Alice Again" },
        });
        expect(upserted.name).toBe("Alice Again");

        expect((yield* query.author.delete({ where: { id: created[0]!.id } })).id).toBe(
          created[0]!.id,
        );
        expect(
          yield* query.author.deleteMany({ where: { email: { endsWith: "example.com" } } }),
        ).toBe(2);
      }),
    );
  });

  test("escapes LIKE wildcard input", async () => {
    expect(
      await run(query.author.findMany({ where: { email: { contains: "%" } } }), shared),
    ).toHaveLength(0);
  });

  test("supports null filters, count, and exists", async () => {
    expect(await run(query.post.count({ where: { body: { isNull: true } } }), shared)).toBe(2);
    expect(await run(query.author.exists({ where: { name: "Alice" } }), shared)).toBe(true);
  });

  test("findUnique throws a typed error", async () => {
    expect(
      run(query.author.findUnique({ where: { email: "missing@example.com" } }), shared),
    ).rejects.toBeInstanceOf(ParanOrmError);
  });

  test("supports offset and cursor pagination", async () => {
    const first = await run(query.post.paginate({ orderBy: [{ id: "asc" }], take: 2 }), shared);
    expect(first.data).toHaveLength(2);
    const second = await run(
      query.post.paginate({
        orderBy: [{ id: "asc" }],
        take: 2,
        after: first.pagination.endCursor!,
      }),
      shared,
    );
    expect(second.data).toHaveLength(1);
    expect(second.data[0]!.id).not.toBe(first.data[0]!.id);
  });

  test("round-trips Unicode cursor values", async () => {
    await run(
      Effect.gen(function* () {
        yield* createSchema();
        const author = yield* query.author.create({
          data: { name: "Author", email: "author@example.com" },
        });
        yield* query.post.createMany({
          data: [
            { title: "日本語", body: null, authorId: author.id },
            { title: "🦊 fox", body: null, authorId: author.id },
          ],
        });

        const first = yield* query.post.paginate({ orderBy: [{ title: "asc" }], take: 1 });
        const second = yield* query.post.paginate({
          orderBy: [{ title: "asc" }],
          take: 1,
          after: first.pagination.endCursor!,
        });
        expect(second.data).toHaveLength(1);
        expect(second.data[0]!.title).not.toBe(first.data[0]!.title);
      }),
    );
  });

  test("rejects malformed cursors", async () => {
    expect(
      run(query.post.paginate({ orderBy: [{ id: "asc" }], take: 2, after: "bad" }), shared),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
