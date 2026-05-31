# VFAT Token Lists

This repo contains chain token list definitions and normalized token logos.

## Layout
- tokenLists/<chainId>.json: JSON array of tokens for a chain
- feeOnTransferTokens/<chainId>.json: JSON array of tokens that take a fee on transfer (rebase / tax / reflection tokens). Consumers like vfat-router exclude these from routing paths because UniswapV2/Aerodrome-style swap math assumes `amountReceived == amountSent` and reverts (`K()` invariant) when the destination pool's transferred-in balance is less than expected.
- logos/<chainId>/<address>.png: lowercased address, 128x128 PNG
- scripts/add-tokens.mjs: add tokens + normalize logo images
- scripts/remove-token.mjs: remove tokens by address + delete matching logos

## Token list format
Each token entry uses:
- chainId (number)
- address (hex string)
- symbol (string)
- decimals (number)

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

Options:
- --input tokens.json
- --token-lists-dir tokenLists
- --logos-dir logos
- --size 128
- --format png
- --force-logo
- --dry-run

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
