# Shodai Subscriptions Agent Wallet plugin

MetaMask Agent Wallet commands for resources that advertise the `shodai-subscription` x402 scheme on Base Sepolia.

The plugin discovers merchant, plan, pricing, setup, status, Agreement, and adapter details from the resource and its protocol responses. It has no fixed merchant or server URL.

## Install

Requires MetaMask Agent Wallet 6.2 or later.

```sh
mm config set experimentalPlugins true
mm plugins install velvet-anvil --accept-permissions
```

Agent Wallet 6.2.0 and 6.2.1 have a host-side post-install defect that rolls
back npm plugin installation. When evaluating with either affected version,
install a local tarball from this checkout:

```sh
npm ci
tarball="$(npm pack --silent | tail -n 1)"
mm config set experimentalPlugins true
mm config set experimentalAllowUnverifiedInstalls true
mm plugins install "file:$PWD/$tarball" --accept-permissions
mm config set experimentalAllowUnverifiedInstalls false
```

The `file:` prefix is required for Agent Wallet to treat the tarball as a local
plugin source. This path was verified with stock Agent Wallet 6.2.1.

## Commands

- `mm shodai subscribe <resource-url> --method POST --body '<JSON>'` discovers the offer on the attempted operation, prepares a native-ETH payer, and retries that same operation after payment. Omit the flags for GET. `--expires-at <ISO date/time>` overrides the one-year authorization default.
- `mm shodai access <resource-url> [--method POST --body '<JSON>']` authenticates and performs a covered operation without another initial charge.
- `mm shodai status <resource-url> [--method POST --body '<JSON>']` discovers the public status endpoint without signing.
- `mm shodai cancel <agreement-address>` disables future renewal.

Public resources must use HTTPS. HTTP is accepted for loopback and private-LAN development resources.

The plugin verifies the derived Hybrid DeleGator payer, adapter, Agreement, chain, recipient, amount, and period before displaying the payer address. Fund that address with an ordinary Base Sepolia ETH transfer outside the plugin, then rerun the same subscribe command. The native-ETH offer's `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` asset is a sentinel, not an ERC-20 contract. A network-ambiguous result is returned to the caller; the plugin does not replay non-idempotent requests automatically.

## Integration findings

Repository-only integration findings are maintained in the public
[`findings/` directory](https://github.com/CNSLabs/shodai-subscriptions-agent-wallet-plugin/tree/main/findings)
and are intentionally excluded from the npm package.

## Develop

```sh
npm ci
npm test
npm run build
npm pack
```
