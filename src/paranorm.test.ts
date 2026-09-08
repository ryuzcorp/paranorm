import { beforeAll, describe, expect, expectTypeOf, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SqliteClient } from "@effect/sql-sqlite-node";
import type { Layer } from "effect";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

import { paranorm, ParanOrmError } from "./index.ts";
import type { Generated } from "./index.ts";

interface DB {
  author: { id: Generated<number>; name: string; email: string };
  post: {
    id: Generated<number>;
    title: string;
    body: string | null;
    authorId: number;
  };
  tag: { id: Generated<number>; name: string };
  post_tag: { postId: number; tagId: number };
}

const sqliteLayer = (filename = ":memory:") =>
  // SAFETY: SqliteClient.layer provides SqlClient when scoped via Effect.scoped.
  SqliteClient.layer({ disableWAL: true, filename }) as Layer.Layer<
    SqlClient | SqliteClient.SqliteClient
  >;

const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient>,
  layer: Layer.Layer<SqlClient | SqliteClient.SqliteClient> = sqliteLayer()
) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));

const createSchema = () =>
  Effect.gen(function* createSchemaTables() {
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

describe("ParanOrm", () => {
  const query = paranorm<DB>();
  const dbFile = path.join(
    mkdtempSync(path.join(tmpdir(), "paranorm-")),
    "shared.db"
  );
  const shared = sqliteLayer(dbFile);
  let aliceId: number;
  let firstPostId: number;

  beforeAll(async () => {
    await run(
      Effect.gen(function* seed() {
        yield* createSchema();
        const sql = yield* SqliteClient.SqliteClient;
        const authors = yield* sql<{ id: number }>`
          INSERT INTO author ${sql
            .insert([
              { email: "alice@acme.com", name: "Alice" },
              { email: "bob@example.com", name: "Bob" },
            ])
            .returning("id")}
        `;
        const [firstAuthor, secondAuthor] = authors;
        expect(firstAuthor).toBeDefined();
        if (!firstAuthor) {
          throw new Error("expected first author");
        }
        aliceId = firstAuthor.id;
        expect(secondAuthor).toBeDefined();
        if (!secondAuthor) {
          throw new Error("expected second author");
        }
        const posts = yield* sql<{ id: number }>`
          INSERT INTO post ${sql
            .insert([
              { authorId: aliceId, body: null, title: "First" },
              { authorId: aliceId, body: "text", title: "Second" },
              { authorId: secondAuthor.id, body: null, title: "Bob post" },
            ])
            .returning("id")}
        `;
        const [firstPost] = posts;
        expect(firstPost).toBeDefined();
        if (!firstPost) {
          throw new Error("expected first post");
        }
        firstPostId = firstPost.id;
        const tags = yield* sql<{ id: number }>`
          INSERT INTO tag ${sql.insert([{ name: "ts" }, { name: "sql" }]).returning("id")}
        `;
        yield* sql`
          INSERT INTO post_tag ${sql.insert(
            tags.map((tag) => ({ postId: firstPostId, tagId: tag.id }))
          )}
        `;
      }),
      shared
    );
  });

  test("creates typed models implicitly from SqlClient", async () => {
    const alice = await run(
      query.author.findFirst({ where: { email: "alice@acme.com" } }),
      shared
    );
    expect(alice?.name).toBe("Alice");
    expect(await run(query.post.count(), shared)).toBe(3);
  });

  test("finds, filters, orders, and selects", async () => {
    const rows = await run(
      query.author.findMany({
        orderBy: [{ name: "asc" }],
        select: { id: true, name: true },
        where: {
          OR: [
            { name: { startsWith: "Ali" } },
            { email: { endsWith: "example.com" } },
          ],
        },
      }),
      shared
    );
    expectTypeOf(rows).toEqualTypeOf<{ id: number; name: string }[]>();
    expect(rows.map((row) => row.name)).toEqual(["Alice", "Bob"]);
    expect(rows[0]).not.toHaveProperty("email");
  });

  test("creates, updates, upserts, and deletes with inferred types", async () => {
    await run(
      Effect.gen(function* crud() {
        yield* createSchema();
        const alice = yield* query.author.create({
          data: { email: "alice@example.com", name: "Alice" },
        });
        expectTypeOf(alice).toEqualTypeOf<{
          id: number;
          name: string;
          email: string;
        }>();

        const created = yield* query.author.createMany({
          data: [
            { email: "bob@example.com", name: "Bob" },
            { email: "carol@example.com", name: "Carol" },
          ],
        });
        expect(created).toHaveLength(2);

        const updated = yield* query.author.update({
          data: { name: "Alicia" },
          where: { id: alice.id },
        });
        expect(updated.name).toBe("Alicia");
        expect(
          yield* query.author.updateMany({ data: { name: "Member" } })
        ).toBe(3);

        const upserted = yield* query.author.upsert({
          create: { email: "alice@example.com", name: "Unused" },
          update: { name: "Alice Again" },
          where: { email: "alice@example.com" },
        });
        expect(upserted.name).toBe("Alice Again");

        const [firstCreated] = created;
        expect(firstCreated).toBeDefined();
        if (!firstCreated) {
          throw new Error("expected first created author");
        }
        expect(
          (yield* query.author.delete({ where: { id: firstCreated.id } })).id
        ).toBe(firstCreated.id);
        expect(
          yield* query.author.deleteMany({
            where: { email: { endsWith: "example.com" } },
          })
        ).toBe(2);
      })
    );
  });

  test("escapes LIKE wildcard input", async () => {
    expect(
      await run(
        query.author.findMany({ where: { email: { contains: "%" } } }),
        shared
      )
    ).toHaveLength(0);
  });

  test("supports null filters, count, and exists", async () => {
    expect(
      await run(query.post.count({ where: { body: { isNull: true } } }), shared)
    ).toBe(2);
    expect(
      await run(query.author.exists({ where: { name: "Alice" } }), shared)
    ).toBe(true);
  });

  test("findUnique throws a typed error", () => {
    expect(
      run(
        query.author.findUnique({ where: { email: "missing@example.com" } }),
        shared
      )
    ).rejects.toBeInstanceOf(ParanOrmError);
  });

  test("supports offset and cursor pagination", async () => {
    const first = await run(
      query.post.paginate({ orderBy: [{ id: "asc" }], take: 2 }),
      shared
    );
    expect(first.data).toHaveLength(2);
    const { endCursor } = first.pagination;
    expect(endCursor).toBeDefined();
    if (!endCursor) {
      throw new Error("expected end cursor");
    }
    const second = await run(
      query.post.paginate({
        after: endCursor,
        orderBy: [{ id: "asc" }],
        take: 2,
      }),
      shared
    );
    expect(second.data).toHaveLength(1);
    const [secondPost] = second.data;
    expect(secondPost).toBeDefined();
    if (!secondPost) {
      throw new Error("expected second page post");
    }
    const [firstPost] = first.data;
    expect(firstPost).toBeDefined();
    if (!firstPost) {
      throw new Error("expected first page post");
    }
    expect(secondPost.id).not.toBe(firstPost.id);
  });

  test("round-trips Unicode cursor values", async () => {
    await run(
      Effect.gen(function* unicodePagination() {
        yield* createSchema();
        const author = yield* query.author.create({
          data: { email: "author@example.com", name: "Author" },
        });
        yield* query.post.createMany({
          data: [
            { authorId: author.id, body: null, title: "日本語" },
            { authorId: author.id, body: null, title: "🦊 fox" },
          ],
        });

        const first = yield* query.post.paginate({
          orderBy: [{ title: "asc" }],
          take: 1,
        });
        const { endCursor: unicodeEndCursor } = first.pagination;
        expect(unicodeEndCursor).toBeDefined();
        if (!unicodeEndCursor) {
          throw new Error("expected unicode end cursor");
        }
        const second = yield* query.post.paginate({
          after: unicodeEndCursor,
          orderBy: [{ title: "asc" }],
          take: 1,
        });
        expect(second.data).toHaveLength(1);
        const [unicodeSecondPost] = second.data;
        expect(unicodeSecondPost).toBeDefined();
        if (!unicodeSecondPost) {
          throw new Error("expected unicode second page post");
        }
        const [unicodeFirstPost] = first.data;
        expect(unicodeFirstPost).toBeDefined();
        if (!unicodeFirstPost) {
          throw new Error("expected unicode first page post");
        }
        expect(unicodeSecondPost.title).not.toBe(unicodeFirstPost.title);
      })
    );
  });

  test("rejects malformed cursors", () => {
    expect(
      run(
        query.post.paginate({
          after: "bad",
          orderBy: [{ id: "asc" }],
          take: 2,
        }),
        shared
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("supports AND, NOT, comparisons, and isNull false", async () => {
    const rows = await run(
      query.post.findMany({
        where: {
          AND: [{ authorId: aliceId }, { title: { not: "Second" } }],
          NOT: { body: { isNull: false } },
        },
      }),
      shared
    );
    expect(rows.map((row) => row.title)).toEqual(["First"]);

    const ranged = await run(
      query.post.findMany({
        where: {
          id: { gte: firstPostId, lt: firstPostId + 2 },
        },
      }),
      shared
    );
    expect(ranged).toHaveLength(2);

    const setFilters = await run(
      query.author.findMany({
        where: {
          name: { in: ["Alice", "Nobody"], notIn: ["Nobody"] },
        },
      }),
      shared
    );
    expect(setFilters.map((row) => row.name)).toEqual(["Alice"]);
  });

  test("createMany empty, findFirst null, and upsert conflict key", async () => {
    await run(
      Effect.gen(function* edges() {
        yield* createSchema();
        expect(yield* query.author.createMany({ data: [] })).toEqual([]);
        expect(
          yield* query.author.findFirst({ where: { email: "nope@x.com" } })
        ).toBeNull();
        const failed = yield* query.author
          .upsert({
            create: { email: "x@y.com", name: "X" },
            update: { name: "Y" },
            where: {},
          })
          .pipe(Effect.flip);
        expect(failed).toBeInstanceOf(ParanOrmError);
        expect(failed).toMatchObject({ code: "BAD_REQUEST" });
      })
    );
  });

  test("supports skip pagination and before cursors", async () => {
    const offsetPage = await run(
      query.post.paginate({
        orderBy: [{ id: "asc" }],
        skip: 1,
        take: 1,
      }),
      shared
    );
    expect(offsetPage.data).toHaveLength(1);
    expect(offsetPage.pagination).toMatchObject({
      endCursor: null,
      hasNext: true,
      hasPrevious: true,
      startCursor: null,
    });

    const first = await run(
      query.post.paginate({
        orderBy: [{ id: "asc" }],
        take: 1,
      }),
      shared
    );
    const { endCursor } = first.pagination;
    expect(endCursor).toBeDefined();
    if (!endCursor) {
      throw new Error("expected end cursor");
    }
    const second = await run(
      query.post.paginate({
        after: endCursor,
        orderBy: [{ id: "asc" }],
        take: 1,
      }),
      shared
    );
    expect(second.pagination.hasPrevious).toBe(true);
    const { startCursor } = second.pagination;
    expect(startCursor).toBeDefined();
    if (!startCursor) {
      throw new Error("expected start cursor");
    }
    const previous = await run(
      query.post.paginate({
        before: startCursor,
        orderBy: [{ id: "asc" }],
        take: 2,
      }),
      shared
    );
    expect(previous.data).toHaveLength(1);
    expect(previous.pagination.hasNext).toBe(true);
    expect(previous.pagination.hasPrevious).toBe(false);
    const [previousRow] = previous.data;
    const [firstRow] = first.data;
    expect(previousRow).toBeDefined();
    expect(firstRow).toBeDefined();
    if (!(previousRow && firstRow)) {
      throw new Error("expected pagination rows");
    }
    expect(previousRow.id).toBe(firstRow.id);
    expect(previous.pagination.startCursor).toBeTruthy();
    expect(previous.pagination.endCursor).toBeTruthy();
  });

  test("supports multi-column keyset cursors", async () => {
    await run(
      Effect.gen(function* multiCursor() {
        yield* createSchema();
        const author = yield* query.author.create({
          data: { email: "multi@example.com", name: "Multi" },
        });
        yield* query.post.createMany({
          data: [
            { authorId: author.id, body: null, title: "A" },
            { authorId: author.id, body: null, title: "A" },
            { authorId: author.id, body: null, title: "B" },
          ],
        });
        const first = yield* query.post.paginate({
          orderBy: [{ title: "asc" }, { id: "asc" }],
          take: 2,
        });
        expect(first.data).toHaveLength(2);
        const { endCursor } = first.pagination;
        expect(endCursor).toBeDefined();
        if (!endCursor) {
          throw new Error("expected multi-column end cursor");
        }
        const second = yield* query.post.paginate({
          after: endCursor,
          orderBy: [{ title: "asc" }, { id: "asc" }],
          take: 2,
        });
        expect(second.data).toHaveLength(1);
        expect(second.data[0]?.title).toBe("B");
      })
    );
  });
});
