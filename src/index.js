const { App } = require('@slack/bolt');
const axios = require('axios');

async function run() {
  try {
    // Initialize Slack Bolt app
    const app = new App({
      token: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      socketMode: true,
    });

    const repository = process.env.REPOSITORY;
    const prNumber = process.env.PR_NUMBER;
    const prTitle = process.env.PR_TITLE;
    const prUrl = process.env.PR_URL;
    const githubToken = process.env.GITHUB_TOKEN;
    const authorizedUsers = process.env.AUTHORIZED_USERS.split(',');
    const channelId = process.env.SLACK_CHANNEL_ID;

    // Send Slack notification
    const result = await app.client.chat.postMessage({
      channel: channelId,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🚨 Critical Vulnerability Detected in PR',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Repository:* <https://github.com/${repository}|${repository}>\n*PR:* #${prNumber} - ${prTitle}\n<${prUrl}|View PR>`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Approve PR',
              },
              action_id: 'approve_pr',
              value: `${repository}:${prNumber}`,
              style: 'primary',
            },
          ],
        },
      ],
    });

    console.log('Slack notification sent successfully');

    // Handle button click
    app.action('approve_pr', async ({ body, ack, client }) => {
      await ack();
      const userId = body.user.id;
      const [repo, prNumber] = body.actions[0].value.split(':');

      if (!authorizedUsers.includes(userId)) {
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          text: `<@${userId}> is not authorized to approve PRs.`,
        });
        return;
      }

      try {
        // Approve PR using Axios
        const response = await axios.post(
          `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`,
          { event: 'APPROVE' },
          {
            headers: {
              Authorization: `token ${githubToken}`,
              Accept: 'application/vnd.github.v3+json',
              'User-Agent': 'GitHub-PR-Approver',
            },
          }
        );

        // Update Slack message
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          text: `PR #${prNumber} approved by <@${userId}>!`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `PR #${prNumber} approved by <@${userId}>!\n<${response.data.html_url}|View approval>`,
              },
            },
          ],
        });

        console.log(`PR #${prNumber} approved by ${userId}`);
      } catch (error) {
        console.error('GitHub API error:', error.response ? error.response.data : error.message);
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          text: `Failed to approve PR #${prNumber}: ${error.message}`,
        });
      }
    });

    // Start Bolt app
    await app.start();
    console.log('Slack Bolt app started');

    // Keep the action running for 10 minutes to handle interactions
    await new Promise(resolve => setTimeout(resolve, 10 * 60 * 1000));
    await app.stop();
    console.log('Slack Bolt app stopped');
  } catch (error) {
    console.error(`Action failed: ${error.message}`);
    process.exit(1);
  }
}

run();
