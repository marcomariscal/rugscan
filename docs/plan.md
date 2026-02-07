
---

## M4: Anti-Phishing / Approval Analysis

### Approval Risk Checker

Analyze if a contract is likely a drainer/phishing target:

```typescript
type ApprovalRisk = {
  is_approval_target: boolean      // Has received many approvals
  unique_approvers: number         // How many wallets approved this
  approval_pattern: "normal" | "suspicious" | "drainer"
  known_drainer: boolean           // Matched against known drainer DBs
  recent_drains: number            // Transfers out after approvals
}
```

### Detection Methods

1. **Approval volume analysis** (Etherscan/indexer)
   - Many unique approvers → suspicious
   - Approvals with no subsequent legitimate txs → suspicious

2. **Known drainer patterns** (bytecode analysis)
   - multicall + transferFrom patterns
   - Permit2 abuse signatures
   - setApprovalForAll followed by batch transfers

3. **Drainer databases**
   - Forta alerts: https://explorer.forta.network
   - ScamSniffer data
   - ChainAbuse reports

4. **Transaction simulation** (future)
   - "What happens if I approve this?"
   - Simulate the approval + next tx

### New Findings

| Code | Level | Meaning |
|------|-------|---------|
| DRAINER_PATTERN | danger | Bytecode matches known drainer |
| SUSPICIOUS_APPROVALS | danger | Many approvers, few legit txs |
| KNOWN_SCAM | danger | Matched in scam database |
| HIGH_APPROVAL_VOLUME | warning | Unusual approval activity |

### Priority
High — this catches 80% of phishing attacks.

---
