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

- `mm shodai subscribe <resource-url>` subscribes and returns protected content.
- `mm shodai access <resource-url>` authenticates with SIWx and retrieves content.
- `mm shodai status <resource-url>` reads subscription and renewal status without signing.
- `mm shodai cancel <agreement-address>` disables future renewal.

Public resources must use HTTPS. HTTP is accepted for loopback and private-LAN development resources.

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
