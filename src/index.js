const core = require('@actions/core');
const { App } = require('@slack/bolt');
const axios = require('axios');

// Utility function to safely log secret info without exposing full value
function debugSecret(name, value) {
  if (!value) {
    return `${name}: undefined or empty`;
  }
  const length = value.length;
  const preview = value.substring(0, 5); // Show first 5 chars for debugging
  const hasSpaces = /\s/.test(value);
  const hasNewlines = /\n/.test(value);
  const hasTabs = /\t/.test(value);
  return `${name}: length=${length}, preview=${preview}, hasSpaces=${hasSpaces}, hasNewlines=${hasNewlines}, hasTabs=${hasTabs}`;
}

async function run() {
  let app;
  try {
    // Retrieve inputs using @actions/core
    const repository = core.getInput('repository', { required: true });
    const prNumber = core.getInput('pr-number', { required: true });
    const prTitle = core.getInput('pr-title', { required: true });
    const prUrl = core.getInput('pr-url', { required: true });
    const githubToken = core.getInput('github-token', { required: true });
    const authorizedUsersInput = core.getInput('authorized-users', { required: true });
    const channelId = process.env.SLACK_CHANNEL_ID;
    const botToken = process.env.SLACK_BOT_TOKEN;
    const appToken = process.env.SLACK_APP_TOKEN;
    const signingSecret = process.env.SLACK_SIGNING_SECRET;

    // Debug: Log secret info
    console.log('DEBUG: Environment variables:');
    console.log(debugSecret('SLACK_BOT_TOKEN', botToken));
    console.log(debugSecret('SLACK_APP_TOKEN', appToken));
    console.log(debugSecret('SLACK_SIGNING_SECRET', signingSecret));
    console.log(debugSecret('SLACK_CHANNEL_ID', channelId));

    // Validate environment variables
    if (!botToken || !appToken || !signingSecret || !channelId) {
      const missing = [];
      if (!botToken) missing.push('SLACK_BOT_TOKEN');
      if (!appToken) missing.push('SLACK_APP_TOKEN');
      if (!signingSecret) missing.push('SLACK_SIGNING_SECRET');
      if (!channelId) missing.push('SLACK_CHANNEL_ID');
      core.setFailed(`Missing required Slack environment variables: ${missing.join(', ')}`);
      return;
    }

    // Validate tokens for invalid characters
    const invalidSecrets = [];
    if (/[\s\n\t]/.test(botToken)) invalidSecrets.push('SLACK_BOT_TOKEN');
    if (/[\s\n\t]/.test(appToken)) invalidSecrets.push('SLACK_APP_TOKEN');
    if (/[\s\n\t]/.test(signingSecret)) invalidSecrets.push('SLACK_SIGNING_SECRET');
    if (invalidSecrets.length > 0) {
      core.setFailed(`The following secrets contain invalid characters (spaces, newlines, or tabs): ${invalidSecrets.join(', ')}`);
      return;
    }

    // Validate token formats
    if (!botToken.startsWith('xoxb-')) {
      core.setFailed('SLACK_BOT_TOKEN does not start with "xoxb-"');
      return;
    }
    if (!appToken.startsWith('xapp-')) {
      core.setFailed('SLACK_APP_TOKEN does not start with "xapp-"');
      return;
    }
    if (!/^[0-9a-f]{32}$/.test(signingSecret)) {
      core.setFailed('SLACK_SIGNING_SECRET is not a 32-character hexadecimal string');
      return;
    }

    // Debug: Log authorized users
    console.log('DEBUG: Authorized users input:', authorizedUsersInput);

    // Handle authorized users (single or comma-separated)
    const authorizedUsers = authorizedUsersInput
      .split(',')
      .map(user => user.trim())
      .filter(user => user !== '');

    if (authorizedUsers.length === 0) {
      core.setFailed('No valid authorized users provided');
      return;
    }
    console.log('DEBUG: Parsed authorized users:', authorizedUsers);

    // Initialize Slack Bolt app
    console.log('DEBUG: Initializing Slack Bolt app...');
    app = new App({
      token: botToken,
      appToken: appToken,
      signingSecret: signingSecret,
      socketMode: true,
    });

    // Debug: Test Slack API connectivity
    console.log('DEBUG: Testing Slack API connectivity...');
    try {
      const apiTest = await app.client.api.test();
      console.log('DEBUG: Slack API test response:', JSON.stringify(apiTest));
    } catch (apiError) {
      console.error('DEBUG: Slack API test failed:', apiError.message);
    }

    // Send Slack notification
    console.log('DEBUG: Sending Slack notification...');
    const result = await app.client.chat.postMessage({
      channel: channelId,
      text: `New PR in ${repository}: #${prNumber} - ${prTitle}`, // Fallback text
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

    console.log('DEBUG: Slack notification sent successfully, message ID:', result.ts);

    // Flag to track if approval is complete
    let approvalComplete = false;

    // Handle button click
    app.action('approve_pr', async ({ body, ack, client }) => {
      await ack();
      console.log('DEBUG: Button click received, user:', body.user.id, 'action value:', body.actions[0].value);
      const userId = body.user.id;
      const [repo, prNumber] = body.actions[0].value.split(':');

      // Debug: Log authorized users during button click
      console.log('DEBUG: Checking authorization, expected users:', authorizedUsers, 'actual user:', userId);
      if (!authorizedUsers.includes(userId)) {
        console.log('DEBUG: User not authorized:', userId);
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          text: `<@${userId}> is not authorized to approve PRs.`,
        });
        return;
      }

      console.log('DEBUG: User authorized, approving PR:', repo, prNumber);
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

        console.log('DEBUG: PR approved, response:', response.data.id);

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
                text: `PR #${prNumber} approved by
