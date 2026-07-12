# payment-sim load test — reconciliation report

## Run parameters

- **generated at**: 2026-07-12T05:27:02.932Z
- **duration (s)**: 600
- **concurrent workers**: 100
- **target rps**: 150
- **injected db failure rate**: 0.02
- **attempted**: 83863
- **accepted**: 81527
- **rejected**: 657
- **failed (injected rollbacks)**: 1679
- **errors**: 0
- **attempted rps**: 140
- **accepted rps**: 136
- **rejections by item**: {"principal":625,"fee_processing":21,"fee_platform":8,"fee_vat":3}

## Reconciliation checks

| check | result | details |
|-------|--------|---------|
| itemization-integrity | ✅ | every payment has exactly 4 items and grand_total = Σ items, fee_total = Σ fee items |
| no-awaiting-payments | ✅ | all persisted payments reached settled |
| settled-events-parity | ✅ | settled without processed_event: 0, processed_event without settled payment: 0 |
| journal-matches-balances | ✅ | accounts.balance == opening - settled debits + settled credits for every account |
| soft-ledger-matches-final | ✅ | Redis soft ledger sum (2dp) == accounts.balance for every account |
| conservation | ✅ | Σ opening = 1000000.00, Σ final = 1000000.00 (diff 0¢) |
| no-negative-balances | ✅ | no account is overdrawn in either store |
| no-pending-soft-entries | ✅ | every soft ledger entry is confirmed or stateless (no leaked holds) |

## Stats

- **accounts**: 26
- **paymentsSettled**: 81527
- **paymentsAwaiting**: 0
- **paymentItems**: 326108
- **processedEvents**: 81527
- **pendingSoftEntries**: 0

## Balance positions (from payment journal vs stores)

| account | opening | settled debits | settled credits | derived | mysql | redis | journal diff | soft diff |
|---------|---------|----------------|-----------------|---------|-------|-------|--------------|-----------|
| fees | 0.00 | 0.00 | 381050.98 | 381050.98 | 381050.98 | 381050.98 | 0¢ | 0¢ |
| merchant-0 | 0.00 | 322340.56 | 324364.16 | 2023.60 | 2023.60 | 2023.60 | 0¢ | 0¢ |
| merchant-1 | 0.00 | 323883.11 | 325378.00 | 1494.89 | 1494.89 | 1494.89 | 0¢ | 0¢ |
| merchant-2 | 0.00 | 340186.36 | 345407.91 | 5221.55 | 5221.55 | 5221.55 | 0¢ | 0¢ |
| merchant-3 | 0.00 | 319050.54 | 320741.73 | 1691.19 | 1691.19 | 1691.19 | 0¢ | 0¢ |
| merchant-4 | 0.00 | 323833.60 | 327921.15 | 4087.55 | 4087.55 | 4087.55 | 0¢ | 0¢ |
| payer-00 | 50000.00 | 339080.35 | 324486.78 | 35406.43 | 35406.43 | 35406.43 | 0¢ | 0¢ |
| payer-01 | 50000.00 | 353026.81 | 322872.50 | 19845.69 | 19845.69 | 19845.69 | 0¢ | 0¢ |
| payer-02 | 50000.00 | 361279.17 | 324152.20 | 12873.03 | 12873.03 | 12873.03 | 0¢ | 0¢ |
| payer-03 | 50000.00 | 339964.57 | 318496.48 | 28531.91 | 28531.91 | 28531.91 | 0¢ | 0¢ |
| payer-04 | 50000.00 | 339559.86 | 320217.05 | 30657.19 | 30657.19 | 30657.19 | 0¢ | 0¢ |
| payer-05 | 50000.00 | 355099.42 | 324906.72 | 19807.30 | 19807.30 | 19807.30 | 0¢ | 0¢ |
| payer-06 | 50000.00 | 343907.88 | 327097.89 | 33190.01 | 33190.01 | 33190.01 | 0¢ | 0¢ |
| payer-07 | 50000.00 | 342752.21 | 321983.62 | 29231.41 | 29231.41 | 29231.41 | 0¢ | 0¢ |
| payer-08 | 50000.00 | 333672.86 | 316200.86 | 32528.00 | 32528.00 | 32528.00 | 0¢ | 0¢ |
| payer-09 | 50000.00 | 346492.51 | 338003.79 | 41511.28 | 41511.28 | 41511.28 | 0¢ | 0¢ |
| payer-10 | 50000.00 | 348548.57 | 328296.35 | 29747.78 | 29747.78 | 29747.78 | 0¢ | 0¢ |
| payer-11 | 50000.00 | 337144.62 | 326491.18 | 39346.56 | 39346.56 | 39346.56 | 0¢ | 0¢ |
| payer-12 | 50000.00 | 349758.60 | 321629.06 | 21870.46 | 21870.46 | 21870.46 | 0¢ | 0¢ |
| payer-13 | 50000.00 | 342739.66 | 322549.16 | 29809.50 | 29809.50 | 29809.50 | 0¢ | 0¢ |
| payer-14 | 50000.00 | 359489.59 | 330346.39 | 20856.80 | 20856.80 | 20856.80 | 0¢ | 0¢ |
| payer-15 | 50000.00 | 360306.89 | 332877.28 | 22570.39 | 22570.39 | 22570.39 | 0¢ | 0¢ |
| payer-16 | 50000.00 | 342065.39 | 335597.67 | 43532.28 | 43532.28 | 43532.28 | 0¢ | 0¢ |
| payer-17 | 50000.00 | 354546.97 | 334717.12 | 30170.15 | 30170.15 | 30170.15 | 0¢ | 0¢ |
| payer-18 | 50000.00 | 351406.03 | 334213.91 | 32807.88 | 32807.88 | 32807.88 | 0¢ | 0¢ |
| payer-19 | 50000.00 | 333580.37 | 333716.56 | 50136.19 | 50136.19 | 50136.19 | 0¢ | 0¢ |

## Verdict: ✅ CONSISTENT
