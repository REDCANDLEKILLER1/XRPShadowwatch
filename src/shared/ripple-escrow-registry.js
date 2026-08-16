/* Shadow Watch — canonical Ripple public escrow owner registry.
   Source/provenance: Ripple-published xrp-ledger.toml account metadata,
   surfaced by XRPSCAN. This file is ownership metadata only; current escrow
   amounts are always queried read-only from the validated XRP Ledger.
   Verified 2026-08-16. */
(function () {
  'use strict';
  if (window.SW_RIPPLE_ESCROW_REGISTRY) return;

  var rows = [
    ['r9NpyVfLfUG8hatuCCHKzosyDtKnBdsEN3', 'Ripple Escrow Wallet #01'],
    ['r9UUEXn3cx2seufBkDa8F86usfjWM6HiYp', 'Ripple Escrow Wallet #02'],
    ['rB3WNZc45gxzW31zxfXdkx8HusAhoqscPn', 'Ripple Escrow Wallet #03'],
    ['rDdXiA3M4mYTQ4cFpWkVXfc2UaAXCFWeCK', 'Ripple Escrow Wallet #04'],
    ['rKDvgGUsNPZxsgmoemfrgXPS2Not4co2op', 'Ripple Escrow Wallet #05'],
    ['rKwJaGmB5Hz24Qs2iyCaTdUuL1WsEXUWy5', 'Ripple Escrow Wallet #06'],
    ['rN8pqRwLYuuvY7pUHurybPC8P6rLqVsu6o', 'Ripple Escrow Wallet #07'],
    ['rNASJdZjY9dToHnNURi3HAUku3duPwbtD1', 'Ripple Escrow Wallet #08'],
    ['rU9qmGM4Y6WWDhiNzkwVKBwwatcoE7YL1T', 'Ripple Escrow Wallet #09'],
    ['rfWPPQBYqYmoFMdVnjzXCagJbz5uajSBXL', 'Ripple Escrow Wallet #10'],
    ['rh2EsAe2xVE71ZBjx7oEL2zpD4zmSs3sY9', 'Ripple Escrow Wallet #11'],
    ['rhEwsCWDCVxDiKxGJAKM6VuXC8EFtJP5gQ', 'Ripple Escrow Wallet #12'],
    ['rncKvRcdDq9hVJpdLdTcKoxsS3NSkXsvfM', 'Ripple Escrow Wallet #13'],
    ['rp6aTJmW3nq1aKt3Jmuz4DPRxksT5PBjpH', 'Ripple Escrow Wallet #14'],
    ['rsjFB8mPWqiZgPUaVh8XYqdfa59PE2d5LG', 'Ripple Escrow Wallet #15'],
    ['rw2hzLZgiQ9q62KCuaTWuFHWfiX7JWg3wY', 'Ripple Escrow Wallet #16'],
    ['rDqGA2GfveHypDguQ1KXrJzYymFZmKxEsF', 'Ripple Escrow Wallet #17'],
    ['rGKHDyj4L6pc7DzRB6LWCR4YfZfzXj2Bdh', 'Ripple Escrow Wallet #18'],
    ['rHGfmgv54kpc3QCZGRXEQKUhLPndbasbQr', 'Ripple Escrow Wallet #19'],
    ['rMhkqz3DeU7GUUJKGZofusbrTwZe6bDyb1', 'Ripple Escrow Wallet #20']
  ];

  var accounts = rows.map(function (r, i) {
    return { index: i + 1, address: r[0], label: r[1], owner: 'Ripple' };
  });
  var byAddress = {};
  accounts.forEach(function (r) { byAddress[r.address] = r; });

  window.SW_RIPPLE_ESCROW_REGISTRY = Object.freeze({
    version: '2026.08.16.1',
    expected_count: 20,
    source: 'Ripple xrp-ledger.toml / XRPSCAN account metadata',
    verified_at: '2026-08-16',
    accounts: Object.freeze(accounts),
    addresses: Object.freeze(accounts.map(function (r) { return r.address; })),
    by_address: Object.freeze(byAddress),
    is_public_escrow_owner: function (address) { return !!byAddress[address]; }
  });
})();
