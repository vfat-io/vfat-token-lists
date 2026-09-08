# Logo alignment review — 8 September 2026, second batch

This batch aligns 129 exact chain/address entries across 19 families. It follows the 34 native ETH, Circle USDC and cbBTC entries aligned in PR #33. Symbols are candidates for review; they do not establish a shared issuer or backing.

The [import manifest](2026-09-08-second-batch.json) records each reviewed contract, the upstream artwork pinned to a commit, its SHA-256, and the contract evidence. It is a review record, not an automatic identity registry. Reproduce the PNGs with:

```sh
npm run add-tokens -- --input docs/logo-alignments/2026-09-08-second-batch.json --logos-only --force-logo
```

All reviewed family members use identical decoded 128×128 PNG pixels. This changes 112 existing files and adds five missing repository PNGs; 12 files already match. Whitelist membership and token metadata are unchanged.

| Family | Reviewed entries |
| --- | ---: |
| AAVE | 5 |
| COMP | 2 |
| CRV | 4 |
| DAI | 7 |
| FRAX | 4 |
| LDO | 2 |
| LINK | 5 |
| PENDLE | 8 |
| SNX | 3 |
| UNI | 5 |
| USDT | 8 |
| USDe | 11 |
| WBTC | 9 |
| WETH | 20 |
| frxUSD | 8 |
| rETH | 5 |
| sUSDe | 6 |
| sfrxUSD | 3 |
| wstETH | 14 |

Aave DAO's reserve address book and the Optimism network token registry verify exact contracts. Pendle, Lido, Ethena, Frax and Chainlink documentation provide additional issuer evidence. The OP WETH predeploy is used only on ETH-gas mainnets in the Superchain registry, or where separately documented by the Aave reserve registry.

Artwork comes from pinned Optimism token assets, current Aave application assets (AAVE, USDe and sUSDe), and existing Ethereum Frax assets. The old AAVE mark and the OP-specific Frax badge are not used as canonical artwork. WETH retains its own wordmark; WBTC, rETH, wstETH, USDe and sUSDe each retain separate branding.

The [remaining review CSV](2026-09-08-remaining-review.csv) accounts for all 158 other entries in the original 321-entry audit. It is a review queue, not 158 confirmed incorrect logos. It includes legitimate ticker collisions, PulseChain forks, Super USDT, bridged/pegged tokens, issuer or metadata questions, and the already visually consistent Sky USDS/sUSDS pairs. The original focused audit does not cover all roughly 10,125 tokens in the app.

Validation: 20 existing Node tests pass on Node 22; all 129 PNGs decode at 128×128 with identical pixels within each family; all 19 upstream artwork hashes match their pinned URLs; whitelist files remain byte-for-byte unchanged. Cloudflare originals and both delivery variants require separate verification because changing GitHub PNGs does not replace existing Cloudflare image IDs.
