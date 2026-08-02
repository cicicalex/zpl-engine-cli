/**
 * The shapes this client must never write down.
 *
 * AUDIT 2026-08-02. `sanitiseStatus` carried a comment saying it "mirrors the
 * regex set in mcp/src/store.ts so both clients redact the same shapes". Both
 * shipped sanitisers were run over one corpus, and the claim was false in both
 * directions:
 *
 *   short Bearer token   CLI leaked it    MCP redacted it
 *   sk_live_<...>        CLI leaked it    MCP redacted it
 *   sk_test_<...>        CLI leaked it    MCP redacted it
 *   Bearer<TAB><token>   CLI redacted it  MCP leaked it
 *
 * The `{16,}` floor on the Bearer pattern was the first of those: a short token
 * is still a token. The Stripe shapes were simply absent.
 *
 * The two lists remain two copies, because the packages ship separately and
 * neither can import the other. What holds them together is this corpus,
 * duplicated verbatim in the MCP's own suite, rather than a comment asserting
 * they match — a comment cannot notice when it stops being true.
 *
 * KEEP THIS LIST IDENTICAL to the one in the MCP repo. Adding a shape here and
 * not there is exactly the drift this replaced.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { sanitiseStatus } from "../dist/db.js";

const HEX = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

/** [label, text containing a secret, the part that must not survive] */
const CORPUS = [
  ["zpl user key", `failed for zpl_u_${HEX}`, `zpl_u_${HEX}`],
  ["zpl user key, wizard prefix", `failed for zpl_u_cli_${HEX}`, `zpl_u_cli_${HEX}`],
  ["zpl service key", `failed for zpl_s_${HEX}`, `zpl_s_${HEX}`],
  ["bearer, long", `Authorization: Bearer ${HEX}${HEX}`, `${HEX}${HEX}`],
  ["bearer, short", "Authorization: Bearer abc123", "abc123"],
  ["bearer, tab separated", `Authorization: Bearer\t${HEX}`, HEX],
  ["openai / anthropic", "key sk-proj-AbCdEf0123456789", "sk-proj-AbCdEf0123456789"],
  ["groq", "key gsk_AbCdEf0123456789", "gsk_AbCdEf0123456789"],
  ["stripe secret, live", "key sk_live_AbCdEf0123456789", "sk_live_AbCdEf0123456789"],
  ["stripe secret, test", "key sk_test_AbCdEf0123456789", "sk_test_AbCdEf0123456789"],
];

test("every shape in the shared corpus is redacted", () => {
  const leaked = [];
  for (const [label, sample, secret] of CORPUS) {
    const out = sanitiseStatus(sample) ?? "";
    if (out.includes(secret)) leaked.push(label);
  }
  assert.deepEqual(
    leaked,
    [],
    "these secret shapes survive sanitiseStatus and would be written to history.json in the " +
      "clear. The MCP's set catches them; this one is supposed to match it.",
  );
});

test("the corpus is big enough to be worth running", () => {
  // A guard over a list is only as good as the list. If someone trims it, the
  // suite should say so rather than quietly assert less.
  assert.ok(
    CORPUS.length >= 10,
    `the shared corpus is down to ${CORPUS.length} shapes; it had 10, one per shape the two ` +
      `clients disagreed about plus the ones they already agreed on`,
  );
  const secrets = new Set(CORPUS.map(([, , s]) => s));
  assert.equal(secrets.size, CORPUS.length, "two corpus rows carry the same secret body");
});

test("ordinary text is left alone", () => {
  // A sanitiser that redacts everything passes the test above and destroys the
  // history file it was meant to protect.
  for (const plain of ["CERTIFIED_NEUTRAL", "HIGH_BIAS", "engine timeout after 35s", "d=9 bias=0.5"]) {
    assert.equal(sanitiseStatus(plain), plain, `sanitiseStatus mangled ordinary text: ${plain}`);
  }
});
