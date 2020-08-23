import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { DocumentData, Query } from '@google-cloud/firestore';
import { TrtlApp, WithdrawalPreview, ServiceError, Account } from 'trtl-apps';

import * as core from './core/coreModule';
import { onAuthUserCreated as processNewGithubAuthUser } from './github/githubModule';
import { AppError } from '../appError';
import { WebAppUser, LinkedTurtleAccount, EmailUser } from '../types';

export const onNewAuthUserCreated = functions.auth.user().onCreate(async (user) => {
  console.log(`creating new user => uid: ${user.uid}`);
  console.log(`user provider data: ${JSON.stringify(user.providerData)}`);

  if (user.providerData.some(p => p.providerId === 'github.com')) {
    await processNewGithubAuthUser(user);
  } else if (user.providerData.some(p => p.providerId === 'password')) {
    await processNewEmailPasswordUser(user);
  } else {
    console.log(`unsupported provider: ${JSON.stringify(user.providerData)}, deleting auth user [${user.uid}]...`);
    await admin.auth().deleteUser(user.uid);
    return;
  }
});

export const userAgreeDisclaimer = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('failed-precondition', 'The function must be called while authenticated.');
  }

  await admin.firestore().doc(`users/${context.auth.uid}`).update({
    disclaimerAccepted: true
  });
});

export const onAccountWrite = functions.firestore.document('accounts/{accountId}').onWrite(async (change, context) => {
  // if this account is linked with an app user, update that user's linked account data
  const account = change.after.exists ? change.after.data() as Account : null;

  if (!account) {
    return;
  }

  const linkedAccount = await getLinkedTurtleAccount(context.params.accountId);

  if (!linkedAccount) {
    return;
  }

  const update: Partial<LinkedTurtleAccount> = {
    balanceUnlocked: account.balanceUnlocked
  }

  await admin.firestore()
    .doc(`users/${linkedAccount.userId}/turtle_accounts/${linkedAccount.accountId}`)
    .update(update)
});

export const onLinkedAccountWrite = functions.firestore
  .document('users/{userId}/turtle_accounts/{accountId}')
  .onWrite(async (change, context) => {
  // if this linked account is not the primary linked account, transfer its balance to the primary
  const linkedAccount = change.after.exists ? change.after.data() as LinkedTurtleAccount : null;

  if (!linkedAccount || linkedAccount.primary) {
    return;
  }

  await transferBalanceToPrimaryAccount(linkedAccount);
});

export const retryTransfersToPrimaryAccounts = functions.pubsub.schedule('every 1 hours').onRun(async (context) => {
  // retry transfers to a users' primary linked account from their other linked accounts.
  const snapshot = await admin.firestore().collectionGroup('turtle_accounts')
                    .where('primary', '==', false)
                    .where('balanceUnlocked', '>', 0)
                    .get();

  if (snapshot.size === 0) {
    return;
  }

  const linkedAccounts = snapshot.docs.map(d => d.data() as LinkedTurtleAccount);
  const jobs = linkedAccounts.map(acc => transferBalanceToPrimaryAccount(acc));

  await Promise.all(jobs);
});

export const userPrepareWithdrawal = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('failed-precondition', 'The function must be called while authenticated.');
  }

  const userId: string | undefined    = context.auth.uid;
  const amount: number | undefined    = data.amount;
  const address: string | undefined   = data.address;

  if (!userId || !amount || !address) {
    throw new functions.https.HttpsError('invalid-argument', 'invalid parameters provided.');
  }

  const [preparedTx, error] = await prepareWithdrawToAddress(userId, amount, address);

  if (!preparedTx) {
    throw new functions.https.HttpsError('internal', (error as AppError).message);
  }

  return preparedTx;
});

export const userWithdraw = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('failed-precondition', 'Authenticattion error.');
  }

  const userId: string = context.auth.uid;
  const preparedWithdrawalId: string | undefined = data.preparedTxId;

  if (!preparedWithdrawalId) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid prepared withdrawal ID.');
  }

  const [appUser, userError] = await getAppUserByUid(userId);

  if (!appUser) {
    console.log((userError as AppError).message);
    throw new functions.https.HttpsError('not-found', (userError as AppError).message);
  }

  if (!appUser.primaryAccountId) {
    throw new functions.https.HttpsError('not-found', 'User does not have a primary turtle account.');
  }

  const [primaryAccount] = await core.getAccount(appUser.primaryAccountId);

  if (!primaryAccount) {
    throw new functions.https.HttpsError('not-found', 'user account not found.');
  }

  const preparedWithdrawal = await core.getPreparedWithdrawal(primaryAccount.id, preparedWithdrawalId);

  if (!preparedWithdrawal) {
    throw new functions.https.HttpsError('not-found', 'Prepared withdrawal not found.');
  }

  const [withdrawal, error] = await core.sendPreparedWithdrawal(preparedWithdrawal, 'webapp');

  if (withdrawal) {
    return withdrawal;
  } else {
    throw new functions.https.HttpsError('aborted', (error as ServiceError).message);
  }
});

export async function linkUserTurtleAccount(appUser: WebAppUser, account: Account): Promise<boolean> {
  // check if account is already linked with a user
  const matchQuery = await admin.firestore().collectionGroup('turtle_accounts')
                      .where('accountId', '==', account.id)
                      .get();

  if (matchQuery.size > 0) {
    const matchedAccount = matchQuery.docs[0].data() as LinkedTurtleAccount;
    console.log(`turtle account [${matchedAccount.accountId}] already linked to user [${appUser.uid}]!`);

    return false;
  }

  // check if this should be the user's primary account
  const snapshot = await admin.firestore()
                    .collection(`users/${appUser.uid}/turtle_accounts`)
                    .where('primary', '==', true)
                    .get();

  const isPrimary = snapshot.size === 0;
  const promises: Promise<any>[] = [];

  // add account to user's list of linked turtle_accounts
  const linkedTurtleAccount: LinkedTurtleAccount = {
    accountId: account.id,
    userId: appUser.uid,
    primary: isPrimary,
    balanceUnlocked: account.balanceUnlocked
  }

  const addAccountPromise = admin.firestore()
    .doc(`users/${appUser.uid}/turtle_accounts/${account.id}`)
    .set(linkedTurtleAccount);

  promises.push(addAccountPromise);

  if (isPrimary) {
    const userUpdate: Partial<WebAppUser> = {
      primaryAccountId: account.id
    }

    const updateUserPromise = admin.firestore()
      .doc(`users/${appUser.uid}`)
      .update(userUpdate);

    promises.push(updateUserPromise);
  }

  await Promise.all(promises);
  console.log(`linked turtle account [${account.id}] with app user [${appUser.uid}].`);

  return true;
}

/**
 *
 * @param userId the user that the linked account belongs to
 * @param accountId if no accountId is provided, will fetch the primary linked account
 *
 */
export async function getLinkedTurtleAccount(userId: string, accountId?: string): Promise<LinkedTurtleAccount | null> {
  let query: Query<DocumentData> = admin.firestore().collection(`users/${userId}/turtle_accounts`);

  if (accountId) {
    query = query.where('accountId', '==', accountId);
  } else {
    query = query.where('primary', '==', true);
  }

  const snapshot = await query.get();

  if (snapshot.size === 0) {
    return null;
  }

  return snapshot.docs[0].data() as LinkedTurtleAccount;
}

export async function getAccountOwner(accountId: string): Promise<[WebAppUser | undefined, undefined | AppError]> {
  const accountsSnapshot = await admin.firestore()
                            .collectionGroup('turtle_accounts')
                            .where('accountId', '==', accountId)
                            .get();

  if (accountsSnapshot.size === 0) {
    return [undefined, new AppError('app/user-not-found')];
  }

  const linkedAccount = accountsSnapshot.docs[0].data() as LinkedTurtleAccount;

  return getAppUserByUid(linkedAccount.userId);
}

async function getAppUserByUid(uid: string): Promise<[WebAppUser | undefined, undefined | AppError]> {
  const snapshot = await admin.firestore().doc(`users/${uid}`).get();

  if (snapshot.exists) {
    return [snapshot.data() as WebAppUser, undefined];
  } else {
    return [undefined, new AppError('app/user-not-found')];
  }
}

async function prepareWithdrawToAddress(
  userId: string,
  amount: number,
  address: string
): Promise<[WithdrawalPreview | undefined, AppError | undefined]> {
  const [appUser, userError] = await getAppUserByUid(userId);

  if (!appUser) {
    return [undefined, userError];
  }

  if (!appUser.primaryAccountId) {
    throw new functions.https.HttpsError('not-found', 'User does not have a primary turtle account.');
  }

  const [primaryAccount] = await core.getAccount(appUser.primaryAccountId);

  if (!primaryAccount) {
    return [undefined, new AppError('app/user-no-account', `app user ${appUser.uid} doesn't have a turtle account assigned!`)];
  }

  return core.prepareWithdrawal(primaryAccount.id, amount, address);
}

/**
 *
 * Transfers the unlocked balance of the provided linked account to the owner's primary linked account.
 *
 * @param linkedAccount the non-primary linked account to transfer the unlocked balance from
 */
async function transferBalanceToPrimaryAccount(linkedAccount: LinkedTurtleAccount) {
  if (linkedAccount.primary) {
    return;
  }

  const primaryAccount = await getLinkedTurtleAccount(linkedAccount.userId);

  if (!primaryAccount) {
    console.log(`user [${linkedAccount.userId}] does not have a primary linked account!`);
    return;
  }

  // transfer the available balance to the primary linked account
  const [transfer, err] = await core.accountTransfer(
                            linkedAccount.accountId,
                            primaryAccount.accountId,
                            linkedAccount.balanceUnlocked);

  if (!transfer) {
    const transferError = err as ServiceError;
    console.log(transferError.message);
  }

  console.log(`transferred [${linkedAccount.balanceUnlocked}] from user [${linkedAccount.userId}] linked account [${linkedAccount.accountId}] to primary account [${primaryAccount.accountId}]`);
}

async function processNewEmailPasswordUser(user: admin.auth.UserRecord): Promise<void> {
  const provider = user.providerData.find(p => p.providerId === 'password');

  if (!provider) {
    console.log(`invalid email/password provider: ${JSON.stringify(user.providerData)} on auth user [${user.uid}].`);
    await admin.auth().deleteUser(user.uid);
    return;
  }

  if (!user.email) {
    console.log(`invalid email address for new auth user [${user.uid}]`);
    await admin.auth().deleteUser(user.uid);
    return;
  }

  const appUser: WebAppUser = {
    uid: user.uid,
    username: user.email,
    email: user.email,
    disclaimerAccepted: false
  }

  await admin.firestore().doc(`users/${appUser.uid}`).set(appUser);

  const [existingEmailUser] = await getEmailUser(user.email);

  if (existingEmailUser) {
    const [account, accError] = await core.getAccount(existingEmailUser.accountId);

    if (account) {
      await linkUserTurtleAccount(appUser, account); // TODO: handle case where linking failed
    } else {
      // TODO: handle this case
      console.log((accError as AppError).message);
    }
  } else {
    const [account, userError] = await createEmailUser(user.email);

    if (account) {
      await linkUserTurtleAccount(appUser, account); // TODO: handle case where linking failed
    } else {
      //TODO: if we failed to create a github user (and turtle account), we should retry later
      console.log(`error creating account for app user [${appUser.uid}]: ${(userError as AppError).message}`);
    }
  }
}

async function createEmailUser(email: string): Promise<[Account | undefined, undefined | AppError]> {
  const [account, accError] = await TrtlApp.createAccount();

  if (!account) {
    return [undefined, new AppError('app/create-account', (accError as ServiceError).message)];
  }

  try {
    const emailUser: EmailUser = {
      email: email,
      accountId: account.id
    }

    const batch = admin.firestore().batch();

    batch.create(admin.firestore().doc(`accounts/${account.id}`), account);
    batch.create(admin.firestore().doc(`platforms/email/users/${email}`), emailUser);

    await batch.commit();

    return [account, undefined];
  } catch (error) {
    return [undefined, new AppError('app/create-account', `error creating EmailUser for: ${email}`)];
  }
}

async function getEmailUser(email: string): Promise<[EmailUser | undefined, undefined | AppError]> {
  const snapshot = await admin.firestore().doc(`platforms/email/users/${email}`).get();

  if (snapshot.exists) {
    return [snapshot.data() as EmailUser, undefined];
  } else {
    return [undefined, new AppError('app/user-not-found')];
  }
}