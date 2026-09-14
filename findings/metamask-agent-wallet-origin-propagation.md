# Plugin message signing cannot propagate the resource origin

## Impact

The Agent Wallet plugin API can request an EVM message signature, but it cannot
identify the HTTP origin whose SIWx challenge is being signed. In the tested
server-wallet flow, stock Agent Wallet 6.2.0 required email approval for each
access signature, including repeated access to the same stable HTTPS resource.

Propagating the resource origin through a diagnostic Agent Wallet patch changed
that observed behavior: two consecutive access signatures completed without
email approval. This establishes that origin propagation affected the signing
decision in this flow. It does not establish the complete rule used by
MetaMask's remote signing or risk service, whose implementation is not present
in this repository.

## Existing origin path

Origin is already a concept below the plugin boundary:

- Agent Wallet's downstream EVM signing context includes an `origin` field.
- Agent Wallet 6.2.0 and 6.2.1 populate that field with the constant
  `"metamask"` for plugin-initiated message signatures.
- The underlying message-controller request type defines optional `origin` as
  the requesting domain.

The missing hop is the public plugin request and its forwarding path. The
plugin-facing `EvmSignMessageInput` request supports the chain ID, message,
intent, and execution options, but no origin. `FoxWalletService.signEvmMessage`
therefore calls the waiting and non-waiting signing methods without one, while
the downstream EVM client's `signatureCtx` supplies the constant origin.
Consequently, a plugin cannot pass the resource origin into the existing
downstream signing context.

## Integration behavior

This plugin does know and validate the relevant origin before signing:

1. [`src/access.ts`](../src/access.ts) receives the merchant's SIWx challenge.
2. The x402 SIWx implementation requires the challenge domain to equal the
   response URL host and the challenge URI origin to equal the response URL
   origin before it invokes the signer.
3. [`src/wallet.ts`](../src/wallet.ts) submits the supported Agent Wallet
   message-signing request. That request has no field for the validated origin.

The plugin should not encode origin in intent prose or expect Agent Wallet to
infer it from arbitrary signed-message text. Neither supplies structured trust
context at the host boundary.

## Reproduction

Use an unmodified Agent Wallet 6.2.0 server wallet, this plugin, and a stable
HTTPS merchant resource:

```sh
mm shodai subscribe <resource-url>
mm shodai access <resource-url>
mm shodai access <resource-url>
```

In the observed run, each access signature required email approval. HTTPS is
important to this reproduction: a private-LAN HTTP resource separately triggers
MetaMask's malicious-signature warning, which would conflate transport-risk
behavior with the missing-origin path.

## Evidence

- The stock 6.2.0 acceptance run required repeated email approval for access to
  the same HTTPS resource.
- Inspection of the 6.2.0 and 6.2.1 plugin request types and runtime forwarding
  path found no plugin-supplied origin and a constant downstream origin.
- A diagnostic patch added origin to the message request and forwarded it
  through both waiting and non-waiting server-wallet signing paths. With the
  actual HTTPS resource origin supplied, two consecutive access signatures
  completed without email approval. The
  [normalized change trace](./evidence/origin-propagation-6.2.0.md) shows each
  origin-specific hop without the generated bundle noise.
- The diagnostic patch is not shipped with this plugin. It remains available in
  the source experiment's Git history at commit `1396184`, path
  `experiments/delegator-subscription/patches/host/@metamask+agent-wallet+6.2.0.patch`.

## Required product decision

Agent Wallet needs a supported way to preserve the requesting origin for
plugin-initiated SIWx signing. Two technically coherent boundaries are:

- accept a canonical origin as structured message-signing context from an
  installed plugin; or
- accept a structured SIWx request and validate its domain and URI in the host.

The first is the smallest API change but treats the installed plugin as the
source of the origin assertion. The second gives the host enough structure to
validate the assertion but adds SIWx-specific responsibility to Agent Wallet.
That trust-boundary choice belongs to Agent Wallet; this integration should not
simulate it with intent text.

## Expected behavior

The actual resource origin should reach Agent Wallet's existing signing context
and be evaluated under MetaMask's existing approval and risk controls. Supplying
an origin must not itself grant approval, suppress MFA, or bypass message-risk
evaluation. Waiting and non-waiting message-signing paths should preserve the
same context.

## Separate HTTP behavior

This finding is independent of the malicious-signature warning observed for a
private-LAN HTTP resource. HTTPS removes that transport-related warning; it does
not add an origin field to the plugin signing request.
