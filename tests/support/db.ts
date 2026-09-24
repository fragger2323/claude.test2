import { db } from '../../src/db/client.js';

/** Deletes all rows (children first). Tests share one DB and run sequentially. */
export async function resetDb(): Promise<void> {
  const d = db();
  await d.queryHit.deleteMany();
  await d.searchQuery.deleteMany();
  await d.finding.deleteMany();
  await d.screenshot.deleteMany();
  await d.analysis.deleteMany();
  await d.website.deleteMany();
  await d.recommendation.deleteMany();
  await d.audit.deleteMany();
  await d.outreach.deleteMany();
  await d.activity.deleteMany();
  await d.followUp.deleteMany();
  await d.outcome.deleteMany();
  await d.campaignLead.deleteMany();
  await d.lead.deleteMany();
  await d.contact.deleteMany();
  await d.location.deleteMany();
  await d.sourceRecord.deleteMany();
  await d.company.deleteMany();
  await d.searchJob.deleteMany();
  await d.savedSearch.deleteMany();
  await d.campaign.deleteMany();
  await d.job.deleteMany();
  await d.modelRun.deleteMany();
  await d.cacheEntry.deleteMany();
  await d.providerUsage.deleteMany();
  await d.session.deleteMany();
  await d.user.deleteMany();
  await d.secretSetting.deleteMany();
  await d.portfolioProject.deleteMany();
  await d.service.deleteMany();
  await d.businessProfile.deleteMany();
  await d.source.deleteMany();
}
