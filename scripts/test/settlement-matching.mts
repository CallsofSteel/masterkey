// MasterKey — settlement-matching tests (RUN_RELIABILITY_SPEC 0.2 follow-up).
//
// Run: npx tsx scripts/test/settlement-matching.mts
// Money-free and network-free: asserts the PURE predicates in src/lib/spend/settlement-match.ts, the rules
// that decide whether an on-chain transaction belongs to a given charge.
//
// The regression these lock down: matching a charge to a settlement on amount+chain ALONE lets a charge
// that never settled claim a DIFFERENT provider's genuine same-amount transaction — it passes RPC receipt
// verification (the tx is real and confirmed) and gets promoted to `settled`, producing a phantom charge
// and mis-attributed per-run cost. Confirmed reachable on 2026-07-26: Sponge reported payment_made:true
// with $0 on-chain for StableStudio while real $0.01 CogVideoX transfers existed in the same window.

import { sameAddress, txRecipient, topicToAddress, recipientAllows } from "../../src/lib/spend/settlement-match";

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

// Real addresses from the 2026-07-26 incident, so the test reads against actual data.
const COGVIDEOX = "0x4111538EaE056E6F521A81EA409BeD50D23293B9"; // received four real $0.01 transfers
const STABLESTUDIO = "0x07F067959297767c887dbfA3C72379c66E82a045"; // received nothing; reported "paid"

// --- sameAddress -------------------------------------------------------------------------------
ok("exact match", sameAddress(COGVIDEOX, COGVIDEOX));
ok("EVM match is case-insensitive (EIP-55 is a checksum, not identity)", sameAddress(COGVIDEOX, COGVIDEOX.toLowerCase()));
ok("different EVM addresses do not match", !sameAddress(COGVIDEOX, STABLESTUDIO));
ok("unknown left side → false", !sameAddress(undefined, COGVIDEOX));
ok("unknown right side → false", !sameAddress(COGVIDEOX, undefined));
ok("both unknown → false", !sameAddress(undefined, undefined));
ok("empty string is not a wildcard", !sameAddress("", COGVIDEOX));
// Solana base58 is case-SENSITIVE — relaxing case there would conflate distinct accounts.
ok("base58 compares exactly", sameAddress("HqpEDUY3kV423fSAv7iaY3cQiz8qN8qEuGqLsG4s6h2c", "HqpEDUY3kV423fSAv7iaY3cQiz8qN8qEuGqLsG4s6h2c"));
ok("base58 case difference is NOT a match", !sameAddress("HqpEDUY3kV423fSAv7iaY3cQiz8qN8qEuGqLsG4s6h2c", "hqpeduy3kv423fsav7iay3cqiz8qn8qeugqlsg4s6h2c"));

// --- txRecipient (Sponge history field-name variants) ------------------------------------------
ok("reads `to`", txRecipient({ to: COGVIDEOX }) === COGVIDEOX);
ok("reads `recipient`", txRecipient({ recipient: COGVIDEOX }) === COGVIDEOX);
ok("reads `destination`", txRecipient({ destination: COGVIDEOX }) === COGVIDEOX);
ok("reads `toAddress`", txRecipient({ toAddress: COGVIDEOX }) === COGVIDEOX);
ok("prefers `to` when several present", txRecipient({ to: COGVIDEOX, recipient: STABLESTUDIO }) === COGVIDEOX);
ok("missing recipient → undefined", txRecipient({ value: "10000" }) === undefined);
ok("non-string recipient → undefined", txRecipient({ to: 42 }) === undefined);

// --- topicToAddress (ERC-20 Transfer log topics[2] = recipient) ---------------------------------
const paddedCog = `0x000000000000000000000000${COGVIDEOX.slice(2)}`;
ok("un-pads a 32-byte topic to an address", topicToAddress(paddedCog) === COGVIDEOX.toLowerCase());
ok("undefined topic → undefined", topicToAddress(undefined) === undefined);
ok("too-short topic → undefined", topicToAddress("0xdeadbeef") === undefined);

// --- recipientAllows: THE regression --------------------------------------------------------
// The exact shape of the 2026-07-26 hazard: a StableStudio charge that never settled, sitting alongside a
// real CogVideoX transfer of a matching amount.
const realCogTx = { direction: "sent", value: "10000", chain: "base", to: COGVIDEOX };

ok(
  "a phantom StableStudio charge CANNOT claim CogVideoX's real transfer",
  !recipientAllows(realCogTx, STABLESTUDIO),
);
ok("the CogVideoX charge still matches its own transfer", recipientAllows(realCogTx, COGVIDEOX));
ok("checksum-cased expectation still matches a lowercase history row", recipientAllows({ to: COGVIDEOX.toLowerCase() }, COGVIDEOX));
// Backward compatibility: rows written before payTo was persisted must behave exactly as before.
ok("unknown expectation → allowed (legacy amount+chain behavior preserved)", recipientAllows(realCogTx, undefined));
ok("known expectation but recipient-less history row → rejected", !recipientAllows({ value: "10000" }, COGVIDEOX));

console.log(`\nsettlement-matching tests: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
