import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, expectTypeOf, test } from "bun:test";

import { type Generated, Kysely, SqliteDialect } from "kysely";

import { createKysola, KysolaError } from "./index.ts";

interface DB {
  author: { id: Generated<number>; name: string; email: string };
  post: { id: Generated<number>; title: string; body: string | null; authorId: number };
  tag: { id: Generated<number>; name: string };
  post_tag: { postId: number; tagId: number };
}

function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
		create table author (id integer primary key autoincrement, name text not null, email text not null unique);
		create table post (id integer primary key autoincrement, title text not null, body text, authorId integer not null);
		create table tag (id integer primary key autoincrement, name text not null);
		create table post_tag (postId integer not null, tagId integer not null);
	`);
  const compatibleDatabase = {
    close: () => sqlite.close(),
    prepare: (query: string) => {
      const statement = sqlite.prepare(query);
      return {
        reader: /^\s*(select|pragma|with)\b/i.test(query) || /\breturning\b/i.test(query),
        all: (parameters: readonly unknown[]) => statement.all(...(parameters as never[])),
        run: (parameters: readonly unknown[]) => statement.run(...(parameters as never[])),
        iterate: (parameters: readonly unknown[]) => statement.iterate(...(parameters as never[])),
      };
    },
  };
  const dialectConfig = { database: compatibleDatabase } as unknown as ConstructorParameters<
    typeof SqliteDialect
  >[0];
  const db = new Kysely<DB>({ dialect: new SqliteDialect(dialectConfig) });
  const query = createKysola(db);
  return { db, query };
}

describe("Kysola", () => {
  let setup: ReturnType<typeof fixture>;
  let aliceId: number;
  let firstPostId: number;

  beforeAll(async () => {
    setup = fixture();
    const [alice, bob] = await setup.db
      .insertInto("author")
      .values([
        { name: "Alice", email: "alice@acme.com" },
        { name: "Bob", email: "bob@example.com" },
      ])
      .returningAll()
      .execute();
    aliceId = alice!.id;
    const posts = await setup.db
      .insertInto("post")
      .values([
        { title: "First", body: null, authorId: aliceId },
        { title: "Second", body: "text", authorId: aliceId },
        { title: "Bob post", body: null, authorId: bob!.id },
      ])
      .returningAll()
      .execute();
    firstPostId = posts[0]!.id;
    const tags = await setup.db
      .insertInto("tag")
      .values([{ name: "ts" }, { name: "sql" }])
      .returningAll()
      .execute();
    await setup.db
      .insertInto("post_tag")
      .values(tags.map((tag) => ({ postId: firstPostId, tagId: tag.id })))
      .execute();
  });

  test("creates typed models implicitly from Kysely", async () => {
    const alice = await setup.query.author.findFirst({ where: { email: "alice@acme.com" } });
    expect(alice?.name).toBe("Alice");
    expect(await setup.query.post.count()).toBe(3);
  });

  test("finds, filters, orders, and selects", async () => {
    const rows = await setup.query.author.findMany({
      where: { OR: [{ name: { startsWith: "Ali" } }, { email: { endsWith: "example.com" } }] },
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true },
    });
    expectTypeOf(rows).toEqualTypeOf<Array<{ id: number; name: string }>>();
    expect(rows.map((row) => row.name)).toEqual(["Alice", "Bob"]);
    expect(rows[0]).not.toHaveProperty("email");
  });

  test("creates, updates, upserts, and deletes with inferred types", async () => {
    const local = fixture();
    const alice = await local.query.author.create({
      data: { name: "Alice", email: "alice@example.com" },
    });
    expectTypeOf(alice).toEqualTypeOf<{ id: number; name: string; email: string }>();

    const created = await local.query.author.createMany({
      data: [
        { name: "Bob", email: "bob@example.com" },
        { name: "Carol", email: "carol@example.com" },
      ],
    });
    expect(created).toHaveLength(2);

    const updated = await local.query.author.update({
      where: { id: alice.id },
      data: { name: "Alicia" },
    });
    expect(updated.name).toBe("Alicia");
    expect(await local.query.author.updateMany({ data: { name: "Member" } })).toBe(3);

    const upserted = await local.query.author.upsert({
      where: { email: "alice@example.com" },
      create: { name: "Unused", email: "alice@example.com" },
      update: { name: "Alice Again" },
    });
    expect(upserted.name).toBe("Alice Again");

    expect((await local.query.author.delete({ where: { id: created[0]!.id } })).id).toBe(
      created[0]!.id,
    );
    expect(
      await local.query.author.deleteMany({ where: { email: { endsWith: "example.com" } } }),
    ).toBe(2);
    await local.db.destroy();
  });

  test("escapes LIKE wildcard input", async () => {
    expect(await setup.query.author.findMany({ where: { email: { contains: "%" } } })).toHaveLength(
      0,
    );
  });

  test("supports null filters, count, and exists", async () => {
    expect(await setup.query.post.count({ where: { body: { isNull: true } } })).toBe(2);
    expect(await setup.query.author.exists({ where: { name: "Alice" } })).toBe(true);
  });

  test("findUnique throws a typed error", async () => {
    expect(
      setup.query.author.findUnique({ where: { email: "missing@example.com" } }),
    ).rejects.toBeInstanceOf(KysolaError);
  });

  test("supports offset and cursor pagination", async () => {
    const first = await setup.query.post.paginate({ orderBy: [{ id: "asc" }], take: 2 });
    expect(first.data).toHaveLength(2);
    const second = await setup.query.post.paginate({
      orderBy: [{ id: "asc" }],
      take: 2,
      after: first.pagination.endCursor!,
    });
    expect(second.data).toHaveLength(1);
    expect(second.data[0]!.id).not.toBe(first.data[0]!.id);
  });

  test("round-trips Unicode cursor values", async () => {
    const local = fixture();
    const author = await local.query.author.create({
      data: { name: "Author", email: "author@example.com" },
    });
    await local.query.post.createMany({
      data: [
        { title: "日本語", body: null, authorId: author.id },
        { title: "🦊 fox", body: null, authorId: author.id },
      ],
    });

    const first = await local.query.post.paginate({ orderBy: [{ title: "asc" }], take: 1 });
    const second = await local.query.post.paginate({
      orderBy: [{ title: "asc" }],
      take: 1,
      after: first.pagination.endCursor!,
    });
    expect(second.data).toHaveLength(1);
    expect(second.data[0]!.title).not.toBe(first.data[0]!.title);
    await local.db.destroy();
  });

  test("rejects malformed cursors", async () => {
    expect(
      setup.query.post.paginate({ orderBy: [{ id: "asc" }], take: 2, after: "bad" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
