import { describe, expect, it } from 'vitest';
import { handleCampaignObjectiveScreen } from '../../src/routes/campaign-objectives';
import { handleSegmentSelectionScreen } from '../../src/routes/campaign-segments';
import { handleChannelIntentScreen } from '../../src/routes/channel-intents';
import { handleStrategicBriefingScreen } from '../../src/routes/strategic-briefings';
import { createMockEnv } from '../helpers';

function fingerprint(html: string): string {
  const title = html.match(/<title>(.*?)<\/title>/)?.[1] ?? '';
  const headings = Array.from(html.matchAll(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/g)).map((match) => match[1].replace(/<[^>]+>/g, '').trim());
  const buttons = Array.from(html.matchAll(/<button[^>]*>(.*?)<\/button>/g)).map((match) => match[1].replace(/<[^>]+>/g, '').trim());
  return JSON.stringify({ title, headings, buttons }, null, 2);
}

describe('campaign planning screen snapshots', () => {
  const env = createMockEnv();

  it('matches the campaign objective screen structure', async () => {
    const response = await handleCampaignObjectiveScreen(new Request('https://test.workers.dev/api/admin/campaign-objectives/screen'), env as any);
    const html = await response.text();
    expect(fingerprint(html)).toMatchInlineSnapshot(`
      "{
        \"title\": \"Campaign Objective | Visibility Marketing\",
        \"headings\": [
          \"Set a clear campaign goal in one pass.\",
          \"Plan Basics\",
          \"What This Plan Says\",
          \"Recent Objectives\"
        ],
        \"buttons\": [
          \"Retry last request\",
          \"Save Campaign Goal\",
          \"Reset\"
        ]
      }"
    `);
  });

  it('matches the segment screen structure', async () => {
    const response = await handleSegmentSelectionScreen(new Request('https://test.workers.dev/api/admin/campaign-segments/screen'), env as any);
    const html = await response.text();
    expect(fingerprint(html)).toMatchInlineSnapshot(`
      "{
        \"title\": \"Segment Selection | Visibility Marketing\",
        \"headings\": [
          \"Build the audience without second-guessing the rules.\",
          \"Audience Rules\",
          \"Who should be included?\",
          \"Who should be left out?\",
          \"Audience Check\",
          \"Saved Audiences\"
        ],
        \"buttons\": [
          \"Add Rule\",
          \"Add Rule\",
          \"Check Audience Size\",
          \"Save Audience\",
          \"Remove\"
        ]
      }"
    `);
  });

  it('matches the channel intent screen structure', async () => {
    const response = await handleChannelIntentScreen(new Request('https://test.workers.dev/api/admin/channel-intent/screen'), env as any);
    const html = await response.text();
    expect(fingerprint(html)).toMatchInlineSnapshot(`
      "{
        \"title\": \"Channel Intent | Visibility Marketing\",
        \"headings\": [
          \"Choose the safest path for each message.\",
          \"Delivery Preferences\",
          \"Delivery Check\"
        ],
        \"buttons\": [
          \"Save Preferences\",
          \"Reload\",
          \"Up\",
          \"Down\"
        ]
      }"
    `);
  });

  it('matches the strategic briefing screen structure', async () => {
    const response = await handleStrategicBriefingScreen(new Request('https://test.workers.dev/api/admin/strategic-briefings/screen'), env as any);
    const html = await response.text();
    expect(fingerprint(html)).toMatchInlineSnapshot(`
      "{
        \"title\": \"Strategic Briefing | Visibility Marketing\",
        \"headings\": [
          \"Shape the message before you send it.\",
          \"Message Brief\",
          \"Ready to Send?\"
        ],
        \"buttons\": [
          \"Send Brief\",
          \"Refresh Summary\"
        ]
      }"
    `);
  });
});
