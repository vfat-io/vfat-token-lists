# VFAT Token Lists

This repo contains chain token list definitions and normalized token logos.

## Layout
- tokenLists/<chainId>.json: JSON array of tokens for a chain
- logos/<chainId>/<address>.png: lowercased address, 128x128 PNG
- scripts/add-tokens.mjs: add tokens + normalize logo images

## Token list format
Each token entry uses:
- chainId (number)
- address (hex string)
- symbol (string)
- decimals (number)

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
- --token-lists-dir tokenLists
- --logos-dir logos
- --size 128
- --format png
- --force-logo
- --dry-run
