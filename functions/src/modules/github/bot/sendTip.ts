import * as admin from 'firebase-admin';
import { TrtlApp, ServiceError, Account } from 'trtl-apps';
import { Application } from 'probot'
import Webhooks from '@octokit/webhooks';

import { GITHUB_LOGIN_URL } from '../../../constants';
import { getGithubIdByUsername, getWebAppUserByGithubId,
  getGithubUser, createGithubUser, createUnclaimedTipDoc } from '../githubModule';
import { TipCommandInfo, Transaction } from '../../../types';
import { AppError } from '../../../appError';
import { getAccountOwner } from '../../appModule';
import * as core from '../../core/coreModule';

export function initListeners(bot: Application) {
  bot.on('issue_comment.created', async context => {
    if (context.payload.action !== 'created') {
      return;
    }

    const commentText = context.payload.comment.body

    if (!commentText.startsWith('.tip ')) {
      return;
    }

    const senderId = context.payload.sender.id;
    const senderLogin = context.payload.sender.login;

    console.log(`comment created by: ${senderLogin}, id: ${senderId}`);

    const [tipInfo, errorText] = getTipCommandInfo(context.payload.comment);

    if (!tipInfo) {
      const commandError = errorText as string;
      console.log(`invalid tip command: ${commandError}`);

      const params = context.issue({ body: commandError });
      await context.github.issues.createComment(params);

      return;
    }

    console.log(`process tip command: ${JSON.stringify(tipInfo)}`);

    const resultMessage = await proccessTipCommand(tipInfo);
    const resultParams = context.issue({ body: resultMessage });

    await context.github.issues.createComment(resultParams);
  });
}

async function proccessTipCommand(tipCommand: TipCommandInfo): Promise<string> {
  const [sendingUser] = await getWebAppUserByGithubId(tipCommand.senderGithubId);

  if (!sendingUser) {
    return `@${tipCommand.senderUsername} you don't have a tips account set up yet! Visit ${GITHUB_LOGIN_URL} to get started.`;
  }

  if (!sendingUser.githubId) {
    return `@${tipCommand.senderUsername} you don't have a tips account set up yet! Visit ${GITHUB_LOGIN_URL} to get started.`;
  }

  const [recipientGithubId, userError] = await getGithubIdByUsername(tipCommand.recipientUsername);

  if (!recipientGithubId) {
    console.log((userError as AppError).message);
    return `Unable to find github user: ${tipCommand.recipientUsername}`;
  }

  const [senderAccount, senderAccError] = await getAccountByGithubId(tipCommand.senderGithubId);

  if (!senderAccount) {
    console.log((senderAccError as AppError).message);
    return `@${tipCommand.senderUsername} you don't have a tips account set up yet! Visit ${GITHUB_LOGIN_URL} to get started.`;
  }

  const [config, configError] = await core.getConfig();

  if (!config) {
    console.log((configError as AppError).message);
    return 'An error occurred, please try again later.';
  }

  const [recipientAccount, recipientAccError] = await getAccountByGithubId(recipientGithubId);
  let recipientAccountId: string | undefined;

  if (!recipientAccount) {
    const [recipientGithubUser, createError] = await createGithubUser(recipientGithubId);

    if (recipientGithubUser) {
      recipientAccountId = recipientGithubUser.accountId;
    } else {
      console.log((createError as AppError).message);
    }
  } else {
    recipientAccountId = recipientAccount.id;
  }

  if (!recipientAccountId) {
    console.log((recipientAccError as AppError).message);
    return `Failed to get tips account for user ${tipCommand.recipientUsername}.`;
  }

  const [transfer, transferError] = await TrtlApp.transfer(senderAccount.id, recipientAccountId, tipCommand.amount);

  if (!transfer) {
    return (transferError as ServiceError).message;
  }

  const senderTxRef = admin.firestore().collection(`accounts/${senderAccount.id}/transactions`).doc();
  const recipientTxRef = admin.firestore().collection(`accounts/${recipientAccountId}/transactions`).doc();

  const senderTx: Transaction = {
    id:                 senderTxRef.id,
    userId:             sendingUser.uid,
    accountId:          senderAccount.id,
    platform:           'github',
    githubId:           sendingUser.githubId,
    timestamp:          transfer.timestamp,
    transferType:       'tip',
    amount:             -tipCommand.amount,
    fee:                0,
    status:             'completed',
    accountTransferId:  transfer.id,
    senderUsername:     tipCommand.senderUsername,
    recipientUsername:  tipCommand.recipientUsername
  }

  const recipientTx: Transaction = {
    id:                 recipientTxRef.id,
    userId:             sendingUser.uid,
    accountId:          senderAccount.id,
    platform:           'github',
    githubId:           sendingUser.githubId,
    timestamp:          transfer.timestamp,
    transferType:       'tip',
    amount:             tipCommand.amount,
    fee:                0,
    status:             'completed',
    accountTransferId:  transfer.id,
    senderUsername:     tipCommand.senderUsername,
    recipientUsername:  tipCommand.recipientUsername
  }

  await Promise.all([
    senderTxRef.set(senderTx),
    recipientTxRef.set(recipientTx),
    core.refreshAccount(senderAccount.id),
    core.refreshAccount(recipientAccountId)
  ]);

  let response = `\`${(tipCommand.amount / 100).toFixed(2)} TRTL\` tip successfully sent to @${tipCommand.recipientUsername}! Visit ${GITHUB_LOGIN_URL} to manage your tips.`;

  const [recipientAppUser] = await getAccountOwner(recipientAccountId);

  if (!recipientAppUser) {
    response += `\n\n @${tipCommand.recipientUsername} you have not linked a tips account yet, visit ${GITHUB_LOGIN_URL} to activate your account.`;

    if (config.githubTipTimeoutDays > 0) {
      const [doc, tipError] = await createUnclaimedTipDoc(
                                transfer,
                                config.githubTipTimeoutDays,
                                tipCommand.senderUsername,
                                tipCommand.recipientUsername,
                                recipientGithubId);

      if (!doc) {
        console.log((tipError as AppError).message);
      } else {
        response += ` You have ${doc.timeoutDays} days to claim your tip before @${tipCommand.senderUsername} is refunded!`;
      }
    }
  }

  return response;
}

async function getAccountByGithubId(githubId: number): Promise<[Account | undefined, undefined | AppError]> {
  const [githubUser, userError] = await getGithubUser(githubId);

  if (!githubUser) {
    return [undefined, userError];
  }

  return core.getAccount(githubUser.accountId);
}

function getTipCommandInfo(
  comment: Webhooks.WebhookPayloadIssueCommentComment
): [TipCommandInfo | undefined, undefined | string] {
  const mentions = getMentions(comment.body);

  if (mentions.length === 0) {
    return [undefined, 'No tip recipient defined.'];
  }

  const amount = getTipAmount(comment.body);

  if (!amount) {
    return [undefined, 'Invalid tip amount.'];
  }

  const tipInfo: TipCommandInfo = {
    senderUsername: comment.user.login,
    senderGithubId: comment.user.id,
    recipientUsername: mentions[0],
    amount: amount
  };

  return [tipInfo, undefined];
}

function getTipAmount(text: string): number | undefined {
  const words = text.split(' ');

  if (words.length < 2) {
    return undefined;
  }

  // get 2nd word in text
  let amount = parseFloat(words[1]);

  if (amount === NaN) {
    return undefined;
  }

  // convert to atomic units
  amount = Math.ceil(amount * 100);

  return amount;
}

function getMentions(text: string): string[] {
  const mentionPattern = /\B@[a-z0-9_-]+/gi;
  const mentionsList = text.match(mentionPattern);

  if (!mentionsList) {
    return [];
  }

  return mentionsList.map((user: any) => user.substring(1));
}
