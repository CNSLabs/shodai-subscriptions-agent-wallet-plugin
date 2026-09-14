# Agent Wallet Shodai subscription plugin

MetaMask Agent Wallet commands for resources that advertise the `shodai-subscription` x402 scheme on Base Sepolia.

The plugin discovers merchant, plan, pricing, setup, status, Agreement, and adapter details from the resource and its protocol responses. It has no fixed merchant or server URL.

## Install

Requires MetaMask Agent Wallet 6.2 or later.

```sh
mm config set experimentalPlugins true
mm plugins install velvet-anvil --accept-permissions
```

Agent Wallet 6.2.0 and 6.2.1 currently roll back this npm installation because
of a host-side post-install defect. See the
[verified finding](./findings/metamask-agent-wallet-plugin-install-rollback.md)
before testing distribution through a stock client.

## Commands

- `mm shodai subscribe <resource-url>` subscribes and returns protected content.
- `mm shodai access <resource-url>` authenticates with SIWx and retrieves content.
- `mm shodai status <resource-url>` reads subscription and renewal status without signing.
- `mm shodai cancel <agreement-address>` disables future renewal.

Public resources must use HTTPS. HTTP is accepted for loopback and private-LAN development resources.

## Integration findings

Findings discovered while testing the plugin with Agent Wallet are indexed in
[`findings/README.md`](./findings/README.md).

## Develop

```sh
npm ci
npm test
npm run build
npm pack
```
