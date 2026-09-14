# Shodai Subscriptions Agent Wallet plugin

MetaMask Agent Wallet commands for resources that advertise the `shodai-subscription` x402 scheme on Base Sepolia.

The plugin discovers merchant, plan, pricing, setup, status, Agreement, and adapter details from the resource and its protocol responses. It has no fixed merchant or server URL.

## Install

Requires MetaMask Agent Wallet 6.2 or later.

```sh
mm config set experimentalPlugins true
mm plugins install velvet-anvil --accept-permissions
```

Agent Wallet 6.2.0 and 6.2.1 currently roll back this npm installation because
of a host-side post-install defect. To evaluate the plugin from this checkout
without modifying Agent Wallet:

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

Repository-only integration findings are maintained under `findings/` and are
intentionally excluded from the npm package.

## Develop

```sh
npm ci
npm test
npm run build
npm pack
```
