# VFAT Token Lists

This repo contains chain token list definitions and normalized token logos.

## Layout
- tokenLists/<chainId>.json: JSON array of tokens for a chain
- feeOnTransferTokens/<chainId>.json: JSON array of tokens that take a fee on transfer or otherwise restrict transfers. Consumers like vfat-router exclude these from routing paths because AMM swap execution assumes token transfers into and out of pools are unrestricted and match the quoted amount.
- logos/<chainId>/<address>.png: lowercased address, 128x128 PNG
- scripts/add-tokens.mjs: add tokens + normalize logo images
- scripts/remove-token.mjs: remove tokens by address + delete matching logos
- tags.json: supported token tags and their membership policies
- tagging/: reviewed batches recording the evidence for token tags
- scripts/update-token-tags.mjs: set or remove tags on existing tokens without touching logos

## Token list format
Each token entry uses:
- chainId (number)
- address (hex string)
- symbol (string)
- decimals (number)
- tags (optional array of identifiers from `tags.json`)

Tags belong to the token at its exact chain and address. A pool matches a selection when any underlying token has any selected tag. Untagged tokens are unclassified. Never infer tags from symbols, names, prices, or price-oracle relationships.

The initial tags are `stablecoin`, `stock`, and `bluechip`; see `tags.json` for definitions. `stock` covers individual company equities and verified wrappers, excluding ETFs. `bluechip` covers a curated set of established crypto assets, including individually verified direct wrapped or bridged representations. Staking derivatives and yield-bearing receipts are excluded. Categories describe assets, not their safety.

### Bluechip membership policy

Review underlying assets against all three criteria:

- Broad, sustained adoption beyond VFAT.
- An established project with several years of operating history.
- Deep liquidity across major trading venues.

The initial underlying asset set is BTC, ETH, and SOL. This is a curated policy, not a universal definition. Market capitalization can help identify candidates, but rankings and short-term price movements never assign the tag automatically. Additions or removals require a reviewed PR documenting the evidence for membership and updating this policy. Each token representation still needs an independently verified chain/address and evidence URL in the tagging batch; approving an underlying asset does not classify every token sharing its symbol.

## Fee-on-transfer token list format
Same shape as the standard token list, plus optional fields:
- `feeBps` — measured tax in bps
- `evidence` — structured object documenting the on-chain proof. Recommended keys: `txHash`, `blockNumber`, `explorer` (URL to the tx on a block explorer), `sender`, `recipient`, the actual amounts split between recipient and tax destination, and a one-line `computation` showing the bps derivation
- `note` — free-form summary

Consumers should treat presence in the list as opaque: any token here is excluded from routing regardless of `feeBps`. Including reproducible `evidence` lets future contributors verify the classification without needing to re-run an audit from scratch.

## Add tokens (contributors)
Contributions must use the `add-tokens` script. Manual edits to `tokenLists/` or `logos/` should be avoided.
Run the script, review the changes, then commit them with a clear message (for example: `Add ABC token on chain 1`).

Provide a JSON file with `chainId`, `address`, `symbol`, `decimals`, `logoURI`.
New token inputs can also include `tags`, for example `"tags": ["stablecoin"]`. The script validates tags and stores them as a sorted, unique array. Use `update-token-tags` to change tags on tokens that are already listed.
`logoURI` can be an `http(s)` URL or a local file path (absolute or relative to the input file).

IMPORTANT: local logo files inside the repo are removed after successful processing (use `--dry-run` to keep them).

Example input:

```json
[
  {
    "chainId": 1,
    "address": "0xabc123...",
    "symbol": "ABC",
    "decimals": 18,
    "logoURI": "https://example.com/token.png"
  },
  {
    "chainId": 1,
    "address": "0xdef456...",
    "symbol": "DEF",
    "decimals": 18,
    "logoURI": "./logos/def.png"
  }
]
```

Run:

```shell
npm run add-tokens -- --input ./new-tokens.json
```

The script also fills missing logos for tokens already in the list, preserving their
existing metadata. Existing logo files are kept unless `--force-logo` is supplied.
Use `--force-logo` to replace an incorrect logo with the input's `logoURI`.

Options:
- --input tokens.json
- --token-lists-dir tokenLists
- --logos-dir logos
- --size 128
- --format png
- --force-logo
- --logos-only (write images without changing whitelist membership)
- --dry-run

## Tag existing tokens

Create a reviewed JSON batch in `tagging/` with the exact chain/address, the complete desired tag list, and an evidence URL. `expectedSymbol` is an optional guard against selecting the wrong entry; the address remains the identity. Preserve the evidence batch in the contribution so reviewers can check membership.

```json
[
  {
    "chainId": 8453,
    "address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "expectedSymbol": "USDC",
    "tags": ["stablecoin"],
    "source": "https://developers.circle.com/stablecoins/usdc-contract-addresses"
  }
]
```

Preview the batch, apply it, then validate the lists:

```shell
npm run update-token-tags -- --input tagging/initial-tags-2026-10-07.json --dry-run
npm run update-token-tags -- --input tagging/initial-tags-2026-10-07.json
npm run validate:tags
npm test
```

The updater validates the whole batch and all token matches before writing. It changes only existing tokens on the specified chains, preserves other metadata, and never changes logos. Legacy entries without `chainId` use their chain filename; conflicting explicit chain IDs fail. Tag lists replace the existing tags; use `"tags": []` to remove the optional field. Reapplying a batch makes no changes. Missing tokens, duplicate updates, ambiguous matches, unexpected symbols, and unknown input tags fail the batch. Reviewed updates can replace or remove invalid or retired existing tags.

The initial batch is a dated review, not an exhaustive classification or an automatically refreshed registry. It records issuer sources and review notes alongside each update; only `tags` are copied into token entries. Review new addresses and wrappers individually. Leave uncertain assets unclassified, and retain existing data when external sources cannot be fetched.

The initial xStocks feed returned null underlying types, so company equity membership was reviewed individually and ETFs were excluded. Each stock entry retains the company name, underlying ISIN, and issuer deployment field used to verify its chain/address.

## Compare and align logos across chains

Generate a self-contained HTML review, JSON report and CSV of tokens sharing an
exact symbol across multiple chains:

```shell
npm run audit-logos -- --output /tmp/logo-audit --symbols ETH,WETH,WBTC,cbBTC,USDC,USDT,AAVE --live
```

By default, the audit reads this repo's token lists. To include native currencies
and automatically listed tokens visible in the app, pass `--input tokens.json`
with an array of `chainId`, `address`, `symbol`, `decimals`, and optional `name`.
Use `--chains chains.json` for chain labels, with entries containing `chainId` and
`name`. `--live` reads the current public Cloudflare images and requires Node 18+;
omit it for an offline GitHub-only report. The audit does not modify logos or
whitelists.

Open `/tmp/logo-audit/index.html`. It shows GitHub and live images side by side,
approximate visual variants, missing images, and visible GitHub/CDN differences.
Images are compared after resizing to 32×32 on white, using a mean channel
difference threshold of 3/255. This groups small encoding/resolution differences;
padding, backgrounds and artwork changes can still form separate variants.
Identical symbols are review candidates, not proof of shared token identity.
Wrappers such as WBTC/cbBTC and ETH/WETH remain separate groups.

After verifying the contracts in a group, choose its GitHub source image and
select the targets to align. Export `logo-alignment.json`, then run:

```shell
npm run add-tokens -- --input logo-alignment.json --logos-only --force-logo
```

The export pins each source to this repo's audited commit. Only committed,
unchanged source PNGs can be selected. `--logos-only` preserves whitelist
membership, including for native currency images. Review and commit the PNG diff,
then use the API repo's `manage-token-logo` CLI to replace the selected Cloudflare
images from that commit. The regular logo batch skips existing Cloudflare images,
so a GitHub correction alone will not replace a stale live image.

## Remove tokens (contributors)
Remove a token by address from all chain lists, plus any matching logo files:

```shell
npm run remove-token -- --remove-address 0xabc123abc123abc123abc123abc123abc123abcd
```

To remove from one specific chain only:

```shell
npm run remove-token -- --remove-address 0xabc123abc123abc123abc123abc123abc123abcd --chain-id 1
```

Options:
- --remove-address 0x...
- --chain-id 1
- --token-lists-dir tokenLists
- --logos-dir logos
- --dry-run
