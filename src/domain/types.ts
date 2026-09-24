/**
 * Shared domain types (used by server, worker and UI — no Node imports here).
 */

export type Confidence = 'high' | 'medium' | 'low';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingCategory =
  | 'technical'
  | 'performance'
  | 'seo'
  | 'accessibility'
  | 'ux'
  | 'visual'
  | 'content'
  | 'security'
  | 'contact';
/** observed = code saw it; measured = numeric measurement; ai_observation = subjective model judgement */
export type FindingKind = 'observed' | 'measured' | 'ai_observation';
export type FindingSource = 'code' | 'ai' | 'lighthouse';
export type Polarity = 'negative' | 'positive' | 'neutral';
export type Viewport = 'desktop' | 'tablet' | 'mobile';

export const VIEWPORTS: Record<Viewport, { width: number; height: number; isMobile: boolean; deviceScaleFactor: number }> = {
  desktop: { width: 1440, height: 900, isMobile: false, deviceScaleFactor: 1 },
  tablet: { width: 820, height: 1180, isMobile: true, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 },
};

export interface EvidenceItem {
  type: 'screenshot' | 'html' | 'metric' | 'network' | 'console' | 'url' | 'text' | 'header' | 'element';
  label?: string;
  /** screenshot id, URL, or other reference */
  ref?: string;
  excerpt?: string;
  value?: number | string | boolean;
  unit?: string;
  selector?: string;
}

export const PROBLEM_TAGS = [
  'no_website',
  'outdated_design',
  'mobile_experience',
  'responsive_bugs',
  'weak_cta',
  'contact_path',
  'conversion_path',
  'navigation_ux',
  'trust_signals',
  'service_presentation',
  'landing_structure',
  'performance',
  'heavy_assets',
  'seo_foundation',
  'local_seo',
  'accessibility',
  'technical_errors',
  'broken_links',
  'security_https',
  'maintenance',
  'visual_quality',
  'branding',
  'imagery',
  'forms',
  'platform_wordpress',
  'platform_tilda',
  'platform_webflow',
  'platform_bitrix',
  'platform_wix',
  'platform_squarespace',
  'platform_joomla',
  'platform_shopify',
  'platform_custom',
] as const;
export type ProblemTag = (typeof PROBLEM_TAGS)[number];

export const PROBLEM_TAG_LABELS: Record<ProblemTag, string> = {
  no_website: 'No official website found',
  outdated_design: 'Outdated design signals',
  mobile_experience: 'Mobile experience issues',
  responsive_bugs: 'Responsive layout bugs',
  weak_cta: 'Weak or missing call to action',
  contact_path: 'Hard-to-find contact path',
  conversion_path: 'Weak conversion path',
  navigation_ux: 'Navigation issues',
  trust_signals: 'Few visible trust signals',
  service_presentation: 'Weak service presentation',
  landing_structure: 'Missing landing-page structure',
  performance: 'Slow loading signals',
  heavy_assets: 'Heavy / unoptimised assets',
  seo_foundation: 'Weak SEO foundation',
  local_seo: 'Local SEO gaps',
  accessibility: 'Accessibility issues',
  technical_errors: 'Technical errors',
  broken_links: 'Broken links / resources',
  security_https: 'HTTPS / security issues',
  maintenance: 'Maintenance / outdated technology',
  visual_quality: 'Visual quality (AI observation)',
  branding: 'Branding consistency (AI observation)',
  imagery: 'Imagery quality',
  forms: 'Form issues',
  platform_wordpress: 'Built on WordPress',
  platform_tilda: 'Built on Tilda',
  platform_webflow: 'Built on Webflow',
  platform_bitrix: 'Built on 1C-Bitrix',
  platform_wix: 'Built on Wix',
  platform_squarespace: 'Built on Squarespace',
  platform_joomla: 'Built on Joomla',
  platform_shopify: 'Built on Shopify',
  platform_custom: 'Custom / unknown stack',
};

export interface FindingDraft {
  code: string;
  category: FindingCategory;
  polarity: Polarity;
  severity: Severity;
  kind: FindingKind;
  source: FindingSource;
  title: string;
  detail: string;
  evidence: EvidenceItem[];
  pageUrl?: string;
  viewport?: Viewport;
  confidence: Confidence;
  problemTags: ProblemTag[];
}

export interface FindingView extends FindingDraft {
  id: string;
  detectedAt: string;
}

// ───────────────────────── CRM ─────────────────────────

export const CRM_STAGES = [
  'new',
  'discovered',
  'verified',
  'analyzed',
  'qualified',
  'contact_ready',
  'contacted',
  'replied',
  'meeting',
  'proposal',
  'won',
  'lost',
  'follow_up',
] as const;
export type CrmStage = (typeof CRM_STAGES)[number];

export const CRM_STAGE_LABELS: Record<CrmStage, string> = {
  new: 'New',
  discovered: 'Discovered',
  verified: 'Verified',
  analyzed: 'Analyzed',
  qualified: 'Qualified',
  contact_ready: 'Contact Ready',
  contacted: 'Contacted',
  replied: 'Replied',
  meeting: 'Meeting',
  proposal: 'Proposal',
  won: 'Won',
  lost: 'Lost',
  follow_up: 'Follow-up',
};

/** Stages set by the pipeline; a lead never moves *backwards* automatically past the user's stages. */
export const PIPELINE_STAGES: CrmStage[] = ['new', 'discovered', 'verified', 'analyzed', 'qualified', 'contact_ready'];
export const USER_STAGES: CrmStage[] = ['contacted', 'replied', 'meeting', 'proposal', 'won', 'lost', 'follow_up'];

export const OUTCOME_TYPES = ['replied', 'no_reply', 'not_interested', 'wrong_fit', 'meeting', 'proposal', 'won', 'lost'] as const;
export type OutcomeType = (typeof OUTCOME_TYPES)[number];
export const OUTCOME_LABELS: Record<OutcomeType, string> = {
  replied: 'Replied',
  no_reply: 'No reply',
  not_interested: 'Not interested',
  wrong_fit: 'Wrong fit',
  meeting: 'Meeting',
  proposal: 'Proposal',
  won: 'Won',
  lost: 'Lost',
};
/** Outcome → CRM stage it implies (if any). */
export const OUTCOME_STAGE: Partial<Record<OutcomeType, CrmStage>> = {
  replied: 'replied',
  meeting: 'meeting',
  proposal: 'proposal',
  won: 'won',
  lost: 'lost',
  not_interested: 'lost',
  wrong_fit: 'lost',
};

export const PRIORITIES = ['very_high', 'high', 'medium', 'low', 'insufficient_data', 'excluded'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = {
  very_high: 'Very High',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  insufficient_data: 'Insufficient data',
  excluded: 'Excluded',
};
export const PRIORITY_RANK: Record<Priority, number> = {
  very_high: 5,
  high: 4,
  medium: 3,
  low: 2,
  insufficient_data: 1,
  excluded: 0,
};

// ───────────────────────── Scoring ─────────────────────────

export type ComponentKey =
  | 'websiteNeed'
  | 'serviceFit'
  | 'businessFit'
  | 'contactability'
  | 'freshness'
  | 'technicalOpportunity'
  | 'commercialRelevance';

export const COMPONENT_LABELS: Record<ComponentKey, string> = {
  websiteNeed: 'Website Need',
  serviceFit: 'Service Fit',
  businessFit: 'Business Fit',
  contactability: 'Contactability',
  freshness: 'Data Freshness',
  technicalOpportunity: 'Technical Opportunity',
  commercialRelevance: 'Commercial Relevance',
};

/** kind: fact (source data) · observation (code-measured) · inference (interpretation) · gap (unknown) */
export interface ScoreFactor {
  label: string;
  points: number;
  kind: 'fact' | 'observation' | 'inference' | 'gap';
  ref?: string;
}

export interface ScoreComponent {
  key: ComponentKey;
  label: string;
  /** 0..100, or null when there is no data to score it */
  score: number | null;
  weight: number;
  factors: ScoreFactor[];
}

export interface LeadFitResult {
  leadFit: number | null;
  components: ScoreComponent[];
  priority: Priority;
  priorityReasons: string[];
  dataCompleteness: number;
}

export type SalesPotential =
  | {
      mode: 'A';
      level: 'high' | 'medium' | 'low';
      label: string;
      factors: ScoreFactor[];
      note: string;
    }
  | {
      mode: 'B';
      target: 'reply' | 'won';
      probability: number;
      interval: [number, number];
      sampleSize: number;
      modelVersion: number;
      trainedAt: string;
      note: string;
      heuristic: { level: 'high' | 'medium' | 'low'; factors: ScoreFactor[] };
    };

export interface ServiceMatch {
  serviceSlug: string;
  serviceName: string;
  fitScore: number;
  kind: 'primary' | 'secondary' | 'do_not_recommend' | 'candidate';
  reasons: Array<{ text: string; findingIds: string[]; tag?: ProblemTag }>;
  exclusionReasons: string[];
}

export interface Discrepancy {
  field: 'phone' | 'website' | 'address' | 'name' | 'email' | 'businessStatus';
  values: Array<{ value: string; sources: Array<{ provider: string; observedAt: string; url?: string }> }>;
  detectedAt: string;
  note?: string;
}

export interface DecisionIntel {
  whyThisLead: string[];
  whyNow: string[];
  whatToOffer: Array<{ service: string; reason: string }>;
  whatNotToOffer: Array<{ service: string; reason: string }>;
  whatToMention: Array<{ text: string; findingId: string; evidence: string }>;
  whatNotToClaim: string[];
  bestContactChannel: { channel: string; value?: string; reason: string; complianceNote?: string } | null;
  mainPainPoint: { title: string; interpretation: string; findingIds: string[] } | null;
  secondaryPainPoint: { title: string; interpretation: string; findingIds: string[] } | null;
  knowledge: { know: string[]; observed: string[]; infer: string[]; unknown: string[] };
  freshness: { label: string; lastVerifiedAt: string | null; analysisAt: string | null; sources: Array<{ provider: string; fetchedAt: string }> };
}

export interface PortfolioMatchResult {
  projectId: string;
  name: string;
  url: string | null;
  score: number;
  reasons: string[];
}

export type ContactStatus = 'verified' | 'probable' | 'unverified';

export const SEARCH_STAGES = [
  'queued',
  'planning',
  'discovering',
  'merging',
  'verifying',
  'website_discovery',
  'analyzing',
  'contacts',
  'qualifying',
  'reporting',
  'completed',
] as const;
export type SearchStage = (typeof SEARCH_STAGES)[number];

export const SEARCH_STAGE_LABELS: Record<SearchStage, string> = {
  queued: 'Queued',
  planning: 'Planning queries',
  discovering: 'Discovering',
  merging: 'Merging',
  verifying: 'Verifying',
  website_discovery: 'Finding websites',
  analyzing: 'Analyzing',
  contacts: 'Finding contacts',
  qualifying: 'Qualifying',
  reporting: 'Generating reports',
  completed: 'Completed',
};

export interface SearchCounts {
  found: number;
  valid: number;
  excluded: number;
  websites: number;
  noWebsite: number;
  analyzed: number;
  analysisFailed: number;
  veryHigh: number;
  high: number;
  medium: number;
  low: number;
  insufficient: number;
  contactReady: number;
  duplicatesMerged: number;
}

export function emptyCounts(): SearchCounts {
  return {
    found: 0,
    valid: 0,
    excluded: 0,
    websites: 0,
    noWebsite: 0,
    analyzed: 0,
    analysisFailed: 0,
    veryHigh: 0,
    high: 0,
    medium: 0,
    low: 0,
    insufficient: 0,
    contactReady: 0,
    duplicatesMerged: 0,
  };
}

export interface ProviderRunStat {
  provider: string;
  name: string;
  status: 'ok' | 'partial' | 'failed' | 'skipped' | 'not_configured' | 'circuit_open';
  calls: number;
  records: number;
  errors: number;
  lastError?: string;
}

export const PROVIDER_LABELS: Record<string, string> = {
  google_places: 'Google Places',
  foursquare: 'Foursquare',
  yelp: 'Yelp',
  osm: 'OpenStreetMap',
  web_search: 'Web Search',
  import: 'Import',
  website: 'Official website',
  manual: 'Manual',
};
