# Origin propagation diagnostic change trace

This is a source-equivalent presentation of the origin-related changes tested
against MetaMask Agent Wallet 6.2.0. It is not an apply-ready patch. The
published Agent Wallet package is bundled and minified, so its mechanical diff
contains entire generated lines plus unrelated experiment changes.

The original mechanical patch is preserved in the source experiment at commit
`1396184`, path
`experiments/delegator-subscription/patches/host/@metamask+agent-wallet+6.2.0.patch`.
The excerpts below retain the behavior of its origin-specific changes while
using readable names and formatting.

## 1. Extend the plugin-host request type

The public SDK request did not contain origin. The diagnostic host type added it
only to message requests:

```diff
+type SdkWalletRequest = Parameters<EvmWalletExecutor>[0];
+type HostWalletRequest =
+  | Exclude<SdkWalletRequest, { kind: "message" }>
+  | (Extract<SdkWalletRequest, { kind: "message" }> & {
+      origin?: string;
+    });
+type HostWalletExecutor = (
+  request: HostWalletRequest,
+  options?: Parameters<EvmWalletExecutor>[1],
+) => ReturnType<EvmWalletExecutor>;

 interface CommandContext {
   walletExecutor: (
     io: CommandIO,
     source: string,
     options?: { emitStepNotices?: boolean },
-  ) => Promise<EvmWalletExecutor>;
+  ) => Promise<HostWalletExecutor>;
 }
```

This was a local host extension; it did not change the published Agent SDK
contract.

## 2. Supply the validated resource origin at the call site

During the diagnostic run, the subscription integration passed the requested
resource's canonical origin after the x402 SIWx library had verified the
challenge against that resource URL:

```diff
 const proof = await createSIWxPayload(challenge, {
   address: wallet.address,
-  signMessage: ({ message }) => wallet.signMessage(message),
+  signMessage: ({ message }) =>
+    wallet.signMessage(message, new URL(resourceUrl).origin),
 }, resourceUrl);

 execute({
   kind: "message",
   chainId,
   message,
+  origin,
   intent,
 });
```

This caller change was part of the diagnostic integration, not the mechanical
Agent Wallet package patch. It was later removed when the experiment returned
to the stock plugin interface.

## 3. Validate syntax and forward through the CLI executor

For a message request, the diagnostic executor required any supplied origin to
be a canonical HTTP or HTTPS origin, then forwarded it into
`signEvmMessage`:

```diff
 case "message": {
+  if (request.origin !== undefined) {
+    const parsed = new URL(request.origin);
+    if (
+      !["http:", "https:"].includes(parsed.protocol) ||
+      parsed.origin !== request.origin
+    ) {
+      throw new Error("Message origin must be a canonical HTTP(S) origin");
+    }
+  }

   return walletService.signEvmMessage({
     state,
     chainId,
     message: request.message,
     wait: false,
     intent: request.intent,
+    ...(request.origin === undefined ? {} : { origin: request.origin }),
     ...(signal === undefined ? {} : { signal }),
   });
 }
```

This check established canonical syntax only. It did not prove that the plugin
obtained the origin from the resource it claimed.

## 4. Preserve origin in waiting and non-waiting signing

`FoxWalletService.signEvmMessage` has separate paths depending on whether the
caller waits for completion. The diagnostic change forwarded origin through
both:

```diff
 if (input.wait === true) {
   return client.signMessage(message, summary, {
     ...(input.signal === undefined ? {} : { signal: input.signal }),
+    ...(input.origin === undefined ? {} : { origin: input.origin }),
   });
 }

-return client.submitPersonalSign(message, summary);
+return client.submitPersonalSign(message, summary, undefined, input.origin);
```

Covering both paths matters because server-wallet signing may either wait in the
current command or return a pending job.

## 5. Override the existing downstream default when supplied

The EVM client already constructed message-signing context with the constant
origin `"metamask"`. The diagnostic change retained that default and overlaid
the supplied origin immediately before submission:

```diff
 async signMessage(message, intent, options) {
   return keyring.signPersonalMessage(
     message,
     address,
-    this.signatureCtx(intent, options?.requestId),
+    {
+      ...this.signatureCtx(intent, options?.requestId),
+      ...(options?.origin === undefined ? {} : { origin: options.origin }),
+    },
     this.resolvePollOpts(options),
   );
 }

-async submitPersonalSign(message, intent, requestId) {
+async submitPersonalSign(message, intent, requestId, origin) {
   return remoteJobs.submitPersonalSign(address, message, {
     ...this.signatureCtx(intent, requestId),
+    ...(origin === undefined ? {} : { origin }),
   });
 }
```

The diagnostic change also removed `origin` from polling options before those
options were passed to the job poller.

## What this evidence establishes

The experiment demonstrated a complete missing data path: plugin request,
executor, wallet service, and EVM signing context. Supplying the HTTPS resource
origin through that path changed the observed repeated-approval behavior.

It does not establish that canonical URL syntax is sufficient validation for a
production API. Agent Wallet still needs to decide whether an installed plugin
may assert origin directly or whether the host must verify a structured SIWx
request itself.
