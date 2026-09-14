# MetaMask Agent Wallet integration findings

This directory records behavior observed while integrating the published
`velvet-anvil` plugin with stock MetaMask Agent Wallet releases. Each confirmed
finding separates reproduced behavior, traced implementation evidence, expected
behavior, and the remaining uncertainty.

## Confirmed findings

| Finding | Verified against | User consequence |
| --- | --- | --- |
| [Valid npm plugin is removed after installation](./metamask-agent-wallet-plugin-install-rollback.md) | Agent Wallet 6.2.0 and 6.2.1 | Blocks installation from npm despite reporting a successful install and exiting with status 0. |
| [Plugin message signing cannot propagate the resource origin](./metamask-agent-wallet-origin-propagation.md) | Runtime path in 6.2.0 and 6.2.1; acceptance behavior in 6.2.0 | In the tested server-wallet flow, repeated SIWx access signatures required repeated email approval. |
| [Plugin management advertises but rejects TOON output](./metamask-agent-wallet-toon-flag-consistency.md) | Agent Wallet 6.2.0 and 6.2.1 | Causes a deterministic failed command and retry when an agent follows the advertised global flag. |

The installation and output-format checks used Node.js 22.23.1, npm 10.9.8,
and isolated home and npm-prefix directories. The origin behavior was observed
with a server wallet on Base Sepolia against a stable HTTPS resource. Package
checks used the public `velvet-anvil@0.1.0` release.

## Not classified as current Agent Wallet defects

The following observations either have an expected cause outside Agent Wallet
or have not been reproduced against the current stock integration:

- The setup-time approval to trust a newly created Agreement is an expected
  authorization decision.
- The malicious-signature warning for a private-LAN HTTP resource is expected
  transport-risk behavior; production resources should use HTTPS.
- Renewal stops when the merchant service is not running.
- Historical unknown-function decoding and stale pending-label observations
  require a fresh reproduction before being reported as current defects. The
  plugin now emits decoded call details and independently verifies transaction
  receipts, which may change their practical impact.
