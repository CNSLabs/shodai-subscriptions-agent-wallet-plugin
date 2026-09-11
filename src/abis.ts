export const adapterAbi = [
  { type: "function", name: "agreement", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "bindAgreement", stateMutability: "nonpayable", inputs: [{ name: "agreement", type: "address" }], outputs: [] },
  { type: "function", name: "installPermissionContext", stateMutability: "nonpayable", inputs: [{ name: "permissionContext", type: "bytes" }], outputs: [] },
  { type: "function", name: "lastPaidThrough", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "periodDuration", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "permissionContext", stateMutability: "view", inputs: [], outputs: [{ type: "bytes" }] },
  { type: "function", name: "startTime", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "event", name: "Renewed", inputs: [{ indexed: false, name: "paidThrough", type: "uint256" }, { indexed: false, name: "amount", type: "uint256" }] },
] as const;

export const agreementAbi = [
  { type: "function", name: "currentState", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "error", name: "RenewalNotAdvanced", inputs: [{ name: "paidThrough", type: "uint256" }, { name: "lastPaidThrough", type: "uint256" }] },
  { type: "function", name: "submitInput", stateMutability: "nonpayable", inputs: [{ name: "inputId", type: "bytes32" }, { name: "payload", type: "bytes" }], outputs: [] },
  { type: "event", name: "ActionExecuted", inputs: [{ indexed: true, name: "fromState", type: "bytes32" }, { indexed: true, name: "toState", type: "bytes32" }, { indexed: true, name: "inputId", type: "bytes32" }, { indexed: false, name: "target", type: "address" }] },
  { type: "event", name: "InputAccepted", inputs: [{ indexed: true, name: "fromState", type: "bytes32" }, { indexed: true, name: "toState", type: "bytes32" }, { indexed: false, name: "inputId", type: "bytes32" }, { indexed: false, name: "payload", type: "bytes" }] },
] as const;

export const erc20Abi = [
  { type: "event", name: "Transfer", inputs: [{ indexed: true, name: "from", type: "address" }, { indexed: true, name: "to", type: "address" }, { indexed: false, name: "value", type: "uint256" }] },
] as const;
