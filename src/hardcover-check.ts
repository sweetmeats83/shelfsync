/**
 * Live check of every Hardcover query ShelfSync uses. Read-only.
 *   docker compose exec shelfsync node dist/hardcover-check.js [isbn] [asin] [bookId]
 * Prints PASS/FAIL per query so unverified field names get caught before use.
 */
import { loadConfig } from "./config.js";
import { HardcoverClient } from "./hardcover.js";

const config = loadConfig();
if (!config.hardcoverToken) {
  console.error("HARDCOVER_TOKEN is not set");
  process.exit(1);
}
const hc = new HardcoverClient({ token: config.hardcoverToken });
const [isbn = "9780593135204", asin, bookIdArg] = process.argv.slice(2);

let failed = 0;
async function check(name: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    console.log(`PASS ${name}:`, JSON.stringify(r));
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}:`, e instanceof Error ? e.message : e);
  }
}

await check("me", () => hc.me());
let foundBook: number | undefined = bookIdArg ? Number(bookIdArg) : undefined;
await check(`editionByIsbn(${isbn})`, async () => {
  const e = await hc.editionByIsbn(isbn);
  foundBook ??= e?.bookId;
  return e;
});
await check(`search("rebecca du maurier")`, async () => (await hc.search("rebecca du maurier")).slice(0, 3));
await check(`bookBySlug(rebecca)`, () => hc.bookBySlug("rebecca"));
if (asin) await check(`editionByAsin(${asin})`, () => hc.editionByAsin(asin));
if (foundBook) {
  await check(`bookById(${foundBook})`, () => hc.bookById(foundBook!));
  await check(`userBook(${foundBook})`, () => hc.userBook(foundBook!));
  await check(`readState(${foundBook})`, () => hc.readState(foundBook!));
}
console.log(failed ? `\n${failed} check(s) failed — paste the output back.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
