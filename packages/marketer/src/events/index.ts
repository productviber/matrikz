/**
 * Events module barrel export.
 */

export { routeEvent } from './router';
export { handleAffiliateConversion } from './affiliate-conversion';
export { handleUserConverted } from './user-converted';
export { handleUserSignup } from './user-signup';
export {
  handleShareCreated,
  handleShareViewed,
  handleShareEngaged,
  handleShareCTAClicked,
  handleShareConverted,
  handleShareRevoked,
} from './share-events';
export {
  handleAppInstalled,
  handleAppUninstalled,
  handleAnalysisCompleted,
  handleFirstAnalysis,
  handleAIChatUsed,
} from './shopify-lifecycle';
export { handlePlanUpgraded, handlePlanDowngraded } from './plan-lifecycle';
export { handleTrialExpiring } from './trial-expiring';
export { handleInsightGenerated } from './insight-generated';
export { handleProspectDiscovered, handleProspectEnriched } from './outbound-events';
