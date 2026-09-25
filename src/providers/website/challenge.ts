/**
 * Bot-protection / challenge interstitials (Cloudflare, DDoS-Guard, captcha walls, WAF blocks).
 * We never try to pass them: the site is reported as "blocked" and nothing is concluded about it.
 */
const CHALLENGE_TITLE = /(just a moment|attention required|checking your browser|ddos-guard|ddos protection|access denied|verify you are human|are you a robot|captcha|security check|please wait while we verify|one more step|request blocked)/i;
const CHALLENGE_BODY = /(cf-challenge|challenge-platform|cf_chl_|g-recaptcha|h-captcha|hcaptcha\.com|cf-turnstile|ddos-guard|sucuri website firewall|incapsula incident|perimeterx|px-captcha|datadome)/i;

export function looksLikeChallenge(title: string, html: string, status?: number | null): boolean {
  if (CHALLENGE_TITLE.test(title.slice(0, 200))) return true;
  if (html.length >= 60_000) return false;
  // Challenge markers on a small page, or on an error status, mean we did not see the real site.
  return CHALLENGE_BODY.test(html) && (status === 403 || status === 503 || status === 429 || html.length < 15_000);
}
