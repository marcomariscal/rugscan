# Post-Scam Hooks & Agent Integration (Exploratory)

Goal: define a post-scam hook system for Assay (formerly Rugscan) that triggers when a scam/rug is detected, routes signals to humans/agents, and feeds collective intelligence without leaking sensitive user data.

## Assumptions
- Assay already produces pre-trade warnings and can classify post-trade outcomes.
- "Post-scam" events should be evidence-backed and versioned to prevent noisy alerts.
- Some integrations may require manual review or rate limits in early milestones.

## 1) Hook Triggers

### When a post-scam event fires
- **Ignored pre-sign warning + adverse outcome**
  - A user received a warning, proceeded, and the transaction results in a loss pattern (e.g., liquidity removed, honeypot detection, blacklist transfer failure).
  - Event: `post_scam.ignored_warning` with `warning_id`, `tx_hash`, `loss_estimate`.
- **Post-facto confirmation**
  - Contract classified as scam after transaction (e.g., liquidity rug, fee changes, admin drain, proxy upgrade to malicious code).
  - Event: `post_scam.confirmed` with confidence and evidence bundle.
- **New scam pattern detected in the wild**
  - Pattern engine or rule update identifies a new class of scams and tags recent contracts.
  - Event: `post_scam.pattern_detected` with pattern version.
- **Known scammer address activity**
  - Activity from a clustered address or known scam ring touches new contracts or user funds.
  - Event: `post_scam.known_actor_activity` with `cluster_id`.

### Trigger sources
- On-chain heuristics (liquidity pull, ownership changes, exploit signatures).
- Off-chain intel feeds (community reports, internal analyst tools).
- User reports (opt-in, gated by verification).

## 2) Hook Actions

### External reporting
- **Threat intel databases (optional, reviewed):**
  - ChainAbuse (community reporting portal).
  - ScamSniffer (if supported API or submission channel).
  - Other curated lists used by wallets/scan tools.
- **Strategy:** start with manual review + batch export; move to API once signal quality is proven.

### Webhook notifications
- Signed webhook POSTs with retry and idempotency.
- Payload includes `event_type`, `confidence`, `evidence_refs`, `chain`, `contract`, `tx_hash`, `observed_at`.

### Agent callbacks
- MCP tool for agents to subscribe to scam events or watchlists.
- Long-poll or streaming interface with filters (chain, confidence, category, address).

### On-chain reporting (feasibility)
- **Optional/experimental:**
  - Attestation frameworks like EAS or chain-specific registries.
  - Pros: public, composable, verifiable.
  - Cons: gas costs, griefing/false reports, slow iteration.
- Recommend deferring to M11+ unless incentives/partnerships are clear.

## 3) Agent-Specific UX

### How an AI agent uses post-scam hooks
- **Alert-driven:** agent subscribes to `post_scam.confirmed` and reacts (notify user, block future trades, open incident ticket).
- **Proactive monitoring:** agent runs a watchlist and asks for confirmation when changes happen.

### MCP tool concepts
- `scam.subscribe(filters)` -> stream of events.
- `scam.watch(address|contract, thresholds)` -> alerts on status changes or suspicious activity.
- `scam.get_evidence(event_id)` -> evidence bundle with proofs/links.

### Proactive monitoring mode
- "Watch this address and alert me if it rugs" should allow:
  - chain + address + timeframe + confidence threshold.
  - alert routing: email, webhook, Slack, in-app.
  - escalation rules (e.g., auto-disable trading).

## 4) Collective Intelligence

### Feedback loop
- Individual detections feed a shared rule engine:
  - New scam pattern -> update rule library -> backfill recent contracts -> produce new events.
- Provide an internal scoring system per event (evidence weight, source trust).

### Privacy considerations
- Share **contract/address-centric signals**, not user identifiers.
- Obfuscate or aggregate user-specific metadata (amounts, timings) where not needed.
- Make reporting opt-in and configurable by organization.

### Incentive alignment
- Give contributors clear value:
  - Faster alerts, reduced false positives, access to higher confidence signals.
  - Credits/discounts or reputation scoring for validated reports.
- Discourage spam via rate limits, proof requirements, and trust tiers.

## 5) Architecture

### Event system design
- **Event sources** -> **Classifier** -> **Evidence store** -> **Event bus** -> **Hooks/Agents**.
- Use an outbox pattern to ensure at-least-once delivery and retry.
- Idempotency keys per event for safe replay.

### Hook registration API
- `POST /hooks` with filters, delivery method, and secret.
- `GET /hooks` list and status.
- `DELETE /hooks/:id` cleanup.
- Filters: `event_type`, `chain`, `confidence_min`, `address`, `cluster_id`.

### Rate limiting + spam prevention
- Per org and per hook rate limits.
- Burst control and sampling for noisy event classes.
- Signed payloads and replay protection for webhooks.

### Verification and anti-false-reporting
- Confidence scoring and evidence requirements for `confirmed` events.
- Separate `suspected` vs `confirmed` with different delivery defaults.
- Analyst review queue for external reports.
- Cluster heuristics: require multiple signals before broad alerting.

## Most valuable patterns
- **Evidence-backed events** > raw alerts: keep credibility high.
- **Two-tier signals** (`suspected` vs `confirmed`) for agent autonomy.
- **Watchlists + filters**: critical for preventing alert fatigue.
- **Shared intel updates**: one detection improves everyone.

## Feasible scope for M9–M10

### M9 (foundational)
- Define event schema + evidence model.
- Produce `post_scam.confirmed` and `post_scam.ignored_warning` internally.
- Webhook delivery with signing, retries, and idempotency.
- Basic watchlist subscription in API (no streaming yet).

### M10 (agent + intel)
- MCP tools: `scam.subscribe`, `scam.watch`, `scam.get_evidence`.
- Confidence tiers and event filtering.
- Manual review workflow for external reporting.
- Optional export of high-confidence events to selected intel partners.

## Open questions
- Which external partners accept API submissions vs manual reporting?
- What thresholds define "confirmed" across chains?
- How to handle opt-in for sharing user-impactful events?
