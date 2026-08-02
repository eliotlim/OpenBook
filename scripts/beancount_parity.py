#!/usr/bin/env python3
"""LGR-13 Fava-parity computation: the Beancount-ecosystem side of the gate.

Loads an exported OpenBook journal with the REAL beancount loader (the same
code path bean-check and Fava sit on — "Fava-computed" on the board means
"computed by the Beancount ecosystem, not by us") and prints, as JSON:

  {
    "transactionCount": <number of Transaction directives>,
    "balances": {"<account>": {"<currency>": <signed integer minor units>}}
  }

The Node side compares this against the ledger's own LGR-8 trial-balance fold
to the cent — per-account balances AND the transaction count, so a dropped or
invented transaction fails the gate even when its postings happen to cancel.

Money discipline mirrors the app's: amounts stay Decimal until they are proven
to be whole cents; a sub-cent amount is an error, never a rounding.

Loader errors (unbalanced entries, failed balance assertions, unknown
accounts…) exit 2 with the errors on stderr — a journal bean-check would
reject must never produce a "parity" number at all.
"""

import json
import sys
from decimal import Decimal

from beancount import loader
from beancount.core.data import Transaction


def main(path: str) -> int:
    entries, errors, _options = loader.load_file(path)
    if errors:
        for error in errors:
            print(str(error), file=sys.stderr)
        return 2

    balances: dict[str, dict[str, int]] = {}
    transaction_count = 0
    for entry in entries:
        if not isinstance(entry, Transaction):
            continue
        transaction_count += 1
        for posting in entry.postings:
            if posting.units is None:  # pragma: no cover — loader interpolates
                print(f"posting without units in {entry.meta}", file=sys.stderr)
                return 2
            minor = posting.units.number * Decimal(100)
            if minor != minor.to_integral_value():
                print(
                    f"sub-cent amount {posting.units} on {posting.account} — "
                    "the ledger stores whole minor units, so this is an export bug",
                    file=sys.stderr,
                )
                return 2
            account = balances.setdefault(posting.account, {})
            currency = posting.units.currency
            account[currency] = account.get(currency, 0) + int(minor)

    print(json.dumps({"transactionCount": transaction_count, "balances": balances}, sort_keys=True))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: beancount_parity.py <journal.beancount>", file=sys.stderr)
        raise SystemExit(64)
    raise SystemExit(main(sys.argv[1]))
