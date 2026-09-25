# Lead scoring

Everything here is deterministic, explainable and recomputed whenever evidence, your services
or your business profile change (**My Business → Re-qualify**, or automatically after an
analysis). Each number in the UI comes with the factors that produced it, and each factor is
tagged as a *fact*, *observation*, *inference* or *gap*.

```
Findings (evidence) ──► problem tags ──► Service matching ──► Lead Fit components ──► Priority
                                                   │                  │                    │
                                                   └──────────► Decision intelligence ◄────┘
                                                                     Sales potential (A/B)
```

## 1. Findings → problem tags

Each finding carries `problemTags` such as `mobile_experience`, `weak_cta`, `outdated_design`,
`seo_foundation`, `broken_links`, `no_website` or `platform_wordpress`. The full list is in
`src/domain/types.ts`. Only negative findings count toward problems. Evidence strength per tag
(0–1) is:

```
strength(tag) = min(1, Σ severity_w × confidence_w × kind_w)
severity_w:   critical 1 · high 0.8 · medium 0.55 · low 0.3 · info 0.15
confidence_w: high 1 · medium 0.8 · low 0.5
kind_w:       measured/observed 1 · ai_observation 0.6
```

Platform tags (WordPress, Tilda, Webflow, Bitrix, Wix, …) are facts: strength 1, or 0.5 at low
confidence. A company without an official website gets `no_website` with strength 1.

## 2. Service matching

Services live in the database (16 defaults in `src/engine/fit/service-catalog.ts`), and you can
edit them under My Business. Each has a name, description, price range, target profile, weighted
problem types, minimum fit, exclusion rules, technologies and project size.

```
raw        = Σ over the service's problem types:  weight × strength(tag)
normalizer = max(4, 0.6 × Σ weights)
coverage   = (weights of problem types with any evidence) / Σ weights
fit        = round(100 × (1 − e^(−1.2 × raw / normalizer)) × (0.7 + 0.3 × coverage))  [+5 if it uses a preferred technology]
```

The curve saturates, so one strong problem cannot max out a service, and broad evidence ranks
above a single strong tag.

- **Eligible** means no exclusion rule fires and `fit ≥ minimumFit` (default 40). Exclusion
  rules: `requires_website`, `requires_tag`, `excludes_tag`, `min_commercial_relevance`,
  `min_evidence_categories`, plus the project types you disallowed in My Business.
- **PRIMARY** is the service you searched for, when it is eligible; otherwise the best eligible
  service.
- **SECONDARY** is the next eligible service whose main problem tag differs from the primary's,
  so it adds something new.
- **DO NOT RECOMMEND** (at most 3) lists services that would be tempting but are excluded, and
  large projects without enough evidence. Each comes with the reason, e.g. *"Problems were
  observed in fewer than 3 areas; a smaller, targeted engagement fits the evidence better than a
  full rebuild."* Obvious exclusions such as "already has a website" are not listed as noise.

Each recommendation lists the evidence that supports it: problem-tag labels with finding titles
and IDs.

## 3. Lead Fit (0–100)

Lead Fit is the weighted average of the components **that have data**. Missing components are
shown as gaps and lower `dataCompleteness`; they never count as zero.

| Component | Weight | How it is computed |
|---|---|---|
| Website Need | 0.25 | No website (confirmed: web search ran, or a source lists only a social/directory profile) → 90. Website *not verified* (no source listed one and no web search ran) → *gap*, and priority is "insufficient data" — never a "no website" pitch. Unreachable and not analysed → 55. Not analysed → *gap*. Otherwise `100 × (1 − e^(−points/60))` where each negative finding adds critical 25 / high 15 / medium 8 / low 3, × confidence (1 / 0.8 / 0.5), × 0.6 for AI observations. The factors list the top categories with an example finding. |
| Service Fit | 0.20 | fit score of the primary service |
| Business Fit | 0.15 | starts at 50. Preferred industry +20; business model matches +10 / differs −10; preferred city +5; preferred country +5; operational +10, temporarily closed −30, permanently closed → 0 and excluded; size proxy (review count / locations) below your minimum −25, meets it +5; website age signal (copyright year) ±. An excluded industry → 0 and excluded. |
| Contactability | 0.15 | e-mail on the website +45 (from a listing +30); contact form +30; verified phone +25 (listed +15); social profile +10; capped at 100 |
| Freshness | 0.05 | freshness score from a live website check, a maintained listing (Google/Foursquare/Yelp, capped at 85) or the source's own last-edit date — never from the time we fetched the data; undated data is a *gap* (see [search-engine.md](search-engine.md#4-verifying-status-freshness-exclusions)) |
| Technical Opportunity | 0.10 | `12 ×` distinct measured technical, performance, SEO, accessibility or security issue types, capped at 100 |
| Commercial Relevance | 0.10 | starts at 30. Price level ≥ 3 +25, = 2 +10, = 1 −5; reviews > 200 +25, > 50 +15, > 10 +5; 2+ locations +15; premium keyword in name or category +10; high-value service industry +5; target price segment ±10. With no price, review or location data it is flagged as unknown. |

## 4. Priority

Rules, checked in order:

| Priority | Rule |
|---|---|
| **Excluded** | closed permanently, excluded industry, do-not-contact, existing client or previously contacted (if those filters are on), no website / no public contact when you asked for those only. The reason is always shown. |
| **Insufficient data** | website found but not analysed yet, or less than 60 % of the scoring inputs available |
| **Very High** | Lead Fit ≥ 72 **and** Website Need ≥ 60 **and** Service Fit ≥ 55 **and** Contactability ≥ 40 |
| **High** | Lead Fit ≥ 60 **and** Website Need ≥ 45 **and** Contactability ≥ 25 |
| **Medium** | Lead Fit ≥ 45 |
| **Low** | everything else, or Website Need below the minimum you set for the search |

Priority reasons list the three strongest components with their top factor, weak components
(below 30), and unknowns. For example: *"Website Need 86: 5 responsive issue(s), e.g. 'No
mobile viewport meta tag'"*, *"Weak: Commercial Relevance 25"*, *"Unknown: Freshness"*.

## 5. Chance of sale: honest version

**Mode A (default)** is a heuristic, labelled as such, **never a percentage**:

```
s = 0.5 × LeadFit + 0.25 × Contactability + 0.25 × (CommercialRelevance or neutral 40)
High ≥ 65 · Medium ≥ 45 · Low otherwise   (Excluded → Low)
```

The UI shows the three factors and states that this is not a probability.

**Mode B** switches on only after the model trained on **your own outcomes** passes the
thresholds in §7. It then shows a probability with an 80 % bootstrap interval, the sample size,
the model version, the training date, the target ("a reply or better" or "a won deal") and the
note *"It is an estimate with the uncertainty shown, not a promise."*

## 6. Decision intelligence (lead detail → "Why this lead")

`src/engine/fit/decision-intel.ts` builds:

- **Why this lead**: the top priority reasons, the evidence behind the primary service, and two
  observed facts.
- **Why now**: only real signals. Newly discovered (≤ 7 days), new issues since the previous
  snapshot, a suspected recent redesign (as a warning), issues verified live within the last 3
  days. Otherwise it says *"No time-sensitive signal detected: timing is neutral."*
- **What to offer / what not to offer**: primary and secondary services with reasons, and the
  do-not-recommend list with reasons.
- **What to mention**: up to three high-confidence observed, customer-visible findings, each with
  its finding ID and evidence.
- **What not to claim**: always "no lost-clients claims" and "no ranking or conversion
  promises". Plus, depending on the data: no Lighthouse scores (not run), AI observations are
  opinions, a listing e-mail may not be monitored, an unreachable site does not mean the
  business is closed, and sources disagree on some details.
- **Best channel**: in EU/UK countries a contact form (a permission-first message) is preferred
  when one exists, then a non-personal e-mail, a form, a phone. Each option carries a note on
  local consent rules.
- **Main and secondary pain point**: problem tags ranked by severity (critical 8, high 5,
  medium 3, low 1), × 1.3 for customer-visible categories, × 0.6 for AI, with diminishing
  returns (`0.6^i`). One severe mobile problem therefore outranks many small SEO notes. Each
  pain point has an interpretation, e.g. *"Likely friction for visitors on phones — potential
  opportunity for website redesign."*
- **Knowledge blocks**: what we KNOW (sources, reviews, status, website, verified contacts),
  what we OBSERVED (measured findings), what we INFER (pain points, AI observations, best
  service) and what we DON'T KNOW (budget, decision maker, awareness, field performance,
  missing components).

## 7. Learning from your outcomes

- When a lead is marked **contacted**, a feature snapshot is frozen: the component scores, Lead
  Fit, priority, contact channel, website status, industry, service and main problems. Later
  data changes cannot leak into training.
- Outcomes (`replied`, `meeting`, `proposal`, `won`, `lost`, `no_reply`, `not_interested`,
  `wrong_fit`) label the snapshot. Target **reply**: replied/meeting/proposal/won vs no
  reply/not interested/wrong fit/lost. Target **won**: won vs the rest.
- **Training** (Learning → Train, or `cli.js train`) uses L2-regularised logistic regression
  with standardisation, one-hot encoding of frequent industries, services and problems, 5-fold
  cross-validation, calibration bins, AUC, Brier score vs the base rate, and 30 bootstrap models
  for intervals.
- **Activation rule**: at least **40** labelled contacted leads, at least **8** in each class,
  **and** a cross-validated Brier score below 97 % of the base-rate Brier. Otherwise the run is
  stored as *insufficient data* or *does not beat the base rate*, and priority stays heuristic.
  The UI shows how many more outcomes are needed.
- **Outcome insights** (Learning): reply rates by observed problem, contact channel and
  priority, plus services sold with deal values. The Dashboard adds performance by source,
  industry, location and service. Every rate shows its sample size and is hidden below 10
  samples (below 5 decided deals for the win rate).
- **Search-quality loop**: query templates are ranked by the high-priority leads and replies
  they produced, and the strategy engine schedules productive variations first.

## 8. Portfolio matching

A portfolio project is suggested only when it is genuinely similar. The score adds up: same
niche +0.5 (or industry text overlap +0.4), same recommended service +0.3, same platform +0.15.
Below **0.4** nothing is suggested, and outreach does not mention a portfolio. Outreach never
claims similarity that is not in these stored facts.

## 9. Audit and outreach

- **Audit** (`src/engine/reports/audit.ts`): executive summary, what works, problems (objective
  before AI, sorted by severity, with evidence), business relevance (interpretations, never loss
  claims), recommended improvements linked to finding IDs, recommended service with scope, not
  recommended, methodology and limitations (e.g. *"Lighthouse was not run"*, *"Business impact
  was not measured and is not claimed"*). It is exported as HTML (strict CSP, embedded
  screenshots), PDF (rendered offline by the browser pool), Markdown and JSON. Client versions
  hide the internal priority.
- **Outreach** (`src/engine/reports/outreach.ts`): tones Friendly, Professional, Premium Agency
  and Ultra Short; languages EN/PL/RU/UK/DE (gender-neutral phrasing); 1–2 plain-language
  observations taken from real findings (`usedFindingIds`); an optional portfolio line; an
  opt-out line. The **linter** (`reports/lint.ts`) flags guarantees, false urgency, outcome
  promises, loss claims, "100 %", percentages not found in the evidence, spam phrases, fake
  compliments, generic greetings, excessive length and drafts that do not mention the company.
  Drafts are editable and re-linted on save. Nothing is ever sent by the system.
