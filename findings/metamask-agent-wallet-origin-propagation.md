# Agent Wallet origin propagation

## Summary

With stock MetaMask Agent Wallet 6.2.0, a plugin-initiated SIWx signature cannot identify the merchant origin to Agent Wallet's signing policy. As a result, accessing subscription content can require email approval for every signature, even after the user has approved that merchant.

This is separate from the "Malicious signature" warning shown for an HTTP resource. HTTPS removes that transport-related warning but does not supply the missing origin at the plugin signing boundary.

## Affected flow

1. [`src/access.ts`](./src/access.ts) obtains the merchant's SIWx challenge, validates its domain against the resource URL, and asks the wallet to sign it.
2. [`src/wallet.ts`](./src/wallet.ts) submits the supported Agent Wallet executor request with `kind: "message"`, the chain ID, message, and intent.
3. That request surface has no field for the validated merchant origin, so the host cannot associate the signature with the merchant for origin-based trust decisions.
4. MetaMask consequently requests out-of-band approval again on later content access.

The plugin cannot correctly repair this itself. Encoding the origin in intent text or asking the host to infer it from arbitrary signed-message content would not provide a trustworthy origin.

## Reproduction

Use an unmodified Agent Wallet 6.2.0 installation in server-wallet mode with this plugin installed and a stable HTTPS merchant resource:

```sh
mm shodai subscribe <resource-url>
mm shodai access <resource-url>
mm shodai access <resource-url>
```

On the affected host, the repeated access signatures require email approval rather than reusing the user's trust decision for that origin.

For a clean reproduction of this issue, use HTTPS. Testing against private-LAN HTTP additionally triggers MetaMask's transport-related signature warning and conflates two independent behaviors.

## Expected behavior

After a user approves the merchant origin under their configured policy, subsequent SIWx signatures for that same origin can be evaluated against that trust decision. The signed SIWx message and its domain validation remain unchanged.

## Requested Agent Wallet change

1. Allow a plugin message-signing request to include its authenticated HTTP or HTTPS origin.
2. Canonicalize and validate that origin in the Agent Wallet host rather than trusting arbitrary plugin text.
3. Forward the validated origin through every server-wallet message-signing path, including waiting and non-waiting submissions, so signing policy evaluates the actual merchant origin.
4. Preserve current behavior when no origin is supplied.

This does not require parsing an origin from the signed message or granting plugins authority to assert arbitrary trust context.

## Evidence

- A split-machine acceptance run using stock Agent Wallet 6.2.0 required email approval again on repeated access.
- A prior diagnostic host patch propagated the validated HTTPS origin through the same signing path; two consecutive access signatures then completed without email approval.
- That diagnostic patch is intentionally not part of this plugin because shipping a private Agent Wallet modification would hide the stock-client experience. Its implementation remains available in the source experiment's Git history at commit `1396184`, path `experiments/delegator-subscription/patches/host/@metamask+agent-wallet+6.2.0.patch`.
