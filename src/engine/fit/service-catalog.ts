import type { ProblemTag } from '../../domain/types.js';

/**
 * Default service catalogue (editable in My Business → Services).
 * problemTypes carry weights: how strongly each observed problem supports the service.
 */

export type ExclusionRule =
  | { type: 'requires_tag'; tag: ProblemTag; reason: string }
  | { type: 'excludes_tag'; tag: ProblemTag; reason: string }
  | { type: 'requires_website'; reason: string }
  | { type: 'min_commercial_relevance'; value: number; reason: string }
  | { type: 'min_evidence_categories'; value: number; reason: string };

export interface WeightedProblem {
  tag: ProblemTag;
  weight: number;
}

export interface ServiceDef {
  slug: string;
  name: string;
  description: string;
  priceMin: number;
  priceMax: number;
  currency: string;
  targetProfile: string;
  problemTypes: WeightedProblem[];
  minimumFit: number;
  excludedCases: ExclusionRule[];
  technologies: string[];
  projectSize: 'small' | 'medium' | 'large';
}

const needsSite: ExclusionRule = { type: 'requires_website', reason: 'No official website was found — there is nothing to improve; a new website would be the relevant offer.' };

export const DEFAULT_SERVICES: ServiceDef[] = [
  {
    slug: 'premium-website-design',
    name: 'Premium website design',
    description: 'Bespoke, high-end design and build for businesses where brand perception drives sales.',
    priceMin: 6000,
    priceMax: 20000,
    currency: 'EUR',
    targetProfile: 'Established premium-segment businesses (clinics, law firms, hospitality) with a dated or generic web presence.',
    problemTypes: [
      { tag: 'outdated_design', weight: 3 },
      { tag: 'visual_quality', weight: 2 },
      { tag: 'branding', weight: 2 },
      { tag: 'service_presentation', weight: 2 },
      { tag: 'imagery', weight: 1 },
      { tag: 'trust_signals', weight: 1 },
      { tag: 'landing_structure', weight: 1 },
      { tag: 'no_website', weight: 3 },
    ],
    minimumFit: 45,
    excludedCases: [{ type: 'min_commercial_relevance', value: 50, reason: 'Premium design needs signals of a premium segment (price level, review volume, positioning); these are weak or unknown.' }],
    technologies: ['Custom', 'Webflow', 'WordPress'],
    projectSize: 'large',
  },
  {
    slug: 'website-redesign',
    name: 'Website redesign',
    description: 'Redesign of an existing website: modern layout, responsive behaviour, clearer structure and CTAs.',
    priceMin: 3000,
    priceMax: 12000,
    currency: 'EUR',
    targetProfile: 'Businesses with a working but outdated or poorly performing website.',
    problemTypes: [
      { tag: 'outdated_design', weight: 3 },
      { tag: 'mobile_experience', weight: 2 },
      { tag: 'responsive_bugs', weight: 2 },
      { tag: 'weak_cta', weight: 2 },
      { tag: 'service_presentation', weight: 2 },
      { tag: 'visual_quality', weight: 2 },
      { tag: 'navigation_ux', weight: 1 },
      { tag: 'conversion_path', weight: 1 },
      { tag: 'landing_structure', weight: 1 },
      { tag: 'maintenance', weight: 1 },
    ],
    minimumFit: 40,
    excludedCases: [needsSite],
    technologies: [],
    projectSize: 'medium',
  },
  {
    slug: 'new-business-website',
    name: 'New business website',
    description: 'First professional website for a business without one.',
    priceMin: 1500,
    priceMax: 6000,
    currency: 'EUR',
    targetProfile: 'Active businesses with no official website (only listings/social profiles).',
    problemTypes: [{ tag: 'no_website', weight: 5 }],
    minimumFit: 40,
    excludedCases: [{ type: 'requires_tag', tag: 'no_website', reason: 'The company already has a website.' }],
    technologies: [],
    projectSize: 'medium',
  },
  {
    slug: 'landing-page',
    name: 'Landing page',
    description: 'A focused conversion page for one service or campaign.',
    priceMin: 800,
    priceMax: 3000,
    currency: 'EUR',
    targetProfile: 'Businesses promoting specific services with weak conversion structure.',
    problemTypes: [
      { tag: 'weak_cta', weight: 3 },
      { tag: 'conversion_path', weight: 3 },
      { tag: 'landing_structure', weight: 3 },
      { tag: 'service_presentation', weight: 1 },
      { tag: 'trust_signals', weight: 1 },
    ],
    minimumFit: 35,
    excludedCases: [],
    technologies: [],
    projectSize: 'small',
  },
  {
    slug: 'webflow-website',
    name: 'Webflow website',
    description: 'Design and build in Webflow with an editor-friendly CMS.',
    priceMin: 3000,
    priceMax: 10000,
    currency: 'EUR',
    targetProfile: 'Marketing-led businesses that want to edit content themselves.',
    problemTypes: [
      { tag: 'outdated_design', weight: 2 },
      { tag: 'platform_webflow', weight: 2 },
      { tag: 'visual_quality', weight: 1 },
      { tag: 'maintenance', weight: 1 },
    ],
    minimumFit: 55,
    excludedCases: [{ type: 'excludes_tag', tag: 'platform_shopify', reason: 'Runs an e-commerce platform (Shopify); a migration is out of scope without catalogue/data details.' }],
    technologies: ['Webflow'],
    projectSize: 'medium',
  },
  {
    slug: 'tilda-website',
    name: 'Tilda website',
    description: 'Fast website or landing on Tilda.',
    priceMin: 600,
    priceMax: 3000,
    currency: 'EUR',
    targetProfile: 'Small businesses needing a quick, affordable site; existing Tilda sites needing improvement.',
    problemTypes: [
      { tag: 'platform_tilda', weight: 3 },
      { tag: 'outdated_design', weight: 1 },
      { tag: 'landing_structure', weight: 1 },
    ],
    minimumFit: 50,
    excludedCases: [{ type: 'requires_tag', tag: 'platform_tilda', reason: 'Only recommended for sites already running on Tilda.' }],
    technologies: ['Tilda'],
    projectSize: 'small',
  },
  {
    slug: 'wordpress-development',
    name: 'WordPress development',
    description: 'Theme/plugin work, performance and maintenance for WordPress sites.',
    priceMin: 1500,
    priceMax: 8000,
    currency: 'EUR',
    targetProfile: 'Businesses on WordPress with technical debt.',
    problemTypes: [
      { tag: 'platform_wordpress', weight: 3 },
      { tag: 'maintenance', weight: 2 },
      { tag: 'performance', weight: 1 },
      { tag: 'technical_errors', weight: 1 },
    ],
    minimumFit: 45,
    excludedCases: [{ type: 'requires_tag', tag: 'platform_wordpress', reason: 'The site does not appear to run on WordPress.' }],
    technologies: ['WordPress'],
    projectSize: 'medium',
  },
  {
    slug: 'bitrix-development',
    name: '1C-Bitrix development',
    description: 'Development and support for 1C-Bitrix sites.',
    priceMin: 2000,
    priceMax: 10000,
    currency: 'EUR',
    targetProfile: 'Businesses running 1C-Bitrix.',
    problemTypes: [
      { tag: 'platform_bitrix', weight: 4 },
      { tag: 'maintenance', weight: 1 },
      { tag: 'technical_errors', weight: 1 },
    ],
    minimumFit: 55,
    excludedCases: [{ type: 'requires_tag', tag: 'platform_bitrix', reason: 'Only relevant for sites running on 1C-Bitrix.' }],
    technologies: ['1C-Bitrix'],
    projectSize: 'medium',
  },
  {
    slug: 'custom-website',
    name: 'Custom-coded website',
    description: 'Full custom rebuild (design + frontend + backend/CMS integration).',
    priceMin: 8000,
    priceMax: 40000,
    currency: 'EUR',
    targetProfile: 'Larger businesses with complex needs and clear budget signals.',
    problemTypes: [
      { tag: 'outdated_design', weight: 2 },
      { tag: 'performance', weight: 2 },
      { tag: 'technical_errors', weight: 1 },
      { tag: 'maintenance', weight: 1 },
      { tag: 'visual_quality', weight: 1 },
      { tag: 'responsive_bugs', weight: 1 },
    ],
    minimumFit: 60,
    excludedCases: [
      { type: 'min_commercial_relevance', value: 60, reason: 'A full custom rebuild needs evidence of budget and complexity (premium segment, several locations, high review volume); current data does not show that.' },
      { type: 'min_evidence_categories', value: 3, reason: 'Problems were observed in fewer than 3 areas; a smaller, targeted engagement fits the evidence better than a full rebuild.' },
    ],
    technologies: ['Custom'],
    projectSize: 'large',
  },
  {
    slug: 'frontend-development',
    name: 'Frontend development',
    description: 'Fixing and rebuilding frontend components, responsive layouts and interactions.',
    priceMin: 2000,
    priceMax: 15000,
    currency: 'EUR',
    targetProfile: 'Sites with broken or inconsistent frontend behaviour.',
    problemTypes: [
      { tag: 'technical_errors', weight: 2 },
      { tag: 'responsive_bugs', weight: 2 },
      { tag: 'performance', weight: 1 },
      { tag: 'accessibility', weight: 1 },
    ],
    minimumFit: 50,
    excludedCases: [needsSite],
    technologies: [],
    projectSize: 'medium',
  },
  {
    slug: 'mobile-optimization',
    name: 'Mobile optimization',
    description: 'Make the existing site work well on phones: layout, tap targets, click-to-call, speed.',
    priceMin: 500,
    priceMax: 2500,
    currency: 'EUR',
    targetProfile: 'Sites that look fine on desktop but struggle on mobile.',
    problemTypes: [
      { tag: 'mobile_experience', weight: 3 },
      { tag: 'responsive_bugs', weight: 3 },
      { tag: 'contact_path', weight: 1 },
    ],
    minimumFit: 35,
    excludedCases: [needsSite],
    technologies: [],
    projectSize: 'small',
  },
  {
    slug: 'performance-optimization',
    name: 'Performance optimization',
    description: 'Image, script and delivery optimisation to make pages load faster.',
    priceMin: 500,
    priceMax: 3000,
    currency: 'EUR',
    targetProfile: 'Content-heavy sites with measurable weight/speed issues.',
    problemTypes: [
      { tag: 'performance', weight: 3 },
      { tag: 'heavy_assets', weight: 3 },
    ],
    minimumFit: 35,
    excludedCases: [needsSite],
    technologies: [],
    projectSize: 'small',
  },
  {
    slug: 'seo-basics',
    name: 'SEO basics',
    description: 'Technical and on-page SEO foundation: titles, meta, headings, structured data, sitemap.',
    priceMin: 400,
    priceMax: 1500,
    currency: 'EUR',
    targetProfile: 'Local businesses missing SEO fundamentals.',
    problemTypes: [
      { tag: 'seo_foundation', weight: 3 },
      { tag: 'local_seo', weight: 2 },
    ],
    minimumFit: 35,
    excludedCases: [needsSite],
    technologies: [],
    projectSize: 'small',
  },
  {
    slug: 'website-maintenance',
    name: 'Website maintenance',
    description: 'Monthly updates, backups, monitoring and small fixes.',
    priceMin: 100,
    priceMax: 400,
    currency: 'EUR',
    targetProfile: 'Sites with outdated components, errors or security gaps.',
    problemTypes: [
      { tag: 'maintenance', weight: 3 },
      { tag: 'technical_errors', weight: 2 },
      { tag: 'broken_links', weight: 2 },
      { tag: 'security_https', weight: 2 },
    ],
    minimumFit: 35,
    excludedCases: [needsSite],
    technologies: [],
    projectSize: 'small',
  },
  {
    slug: 'bug-fixing',
    name: 'Bug fixing',
    description: 'Targeted fixes for errors, broken links and broken forms.',
    priceMin: 200,
    priceMax: 1500,
    currency: 'EUR',
    targetProfile: 'Sites with concrete, observable defects.',
    problemTypes: [
      { tag: 'technical_errors', weight: 3 },
      { tag: 'broken_links', weight: 3 },
      { tag: 'forms', weight: 1 },
    ],
    minimumFit: 35,
    excludedCases: [needsSite],
    technologies: [],
    projectSize: 'small',
  },
  {
    slug: 'ux-improvement',
    name: 'UX improvement',
    description: 'Improve conversion paths: CTAs, contact discoverability, navigation, forms and trust elements.',
    priceMin: 1000,
    priceMax: 5000,
    currency: 'EUR',
    targetProfile: 'Sites where visitors struggle to find the next step.',
    problemTypes: [
      { tag: 'weak_cta', weight: 2 },
      { tag: 'contact_path', weight: 2 },
      { tag: 'conversion_path', weight: 2 },
      { tag: 'navigation_ux', weight: 2 },
      { tag: 'trust_signals', weight: 1 },
      { tag: 'forms', weight: 1 },
      { tag: 'accessibility', weight: 1 },
    ],
    minimumFit: 35,
    excludedCases: [needsSite],
    technologies: [],
    projectSize: 'medium',
  },
];
