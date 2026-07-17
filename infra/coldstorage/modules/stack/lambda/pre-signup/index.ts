/**
 * Cognito pre-sign-up trigger — the AWS half of one-email-one-account (decision table: decide.ts).
 *
 * Wired to the user pool by infra (`lambda.tf` → `lambda_config.pre_sign_up`); fires on native
 * SignUp, on a federated identity's FIRST sign-in, and on AdminCreateUser (including our own shell
 * creation below, which decide() lets straight through).
 *
 * Known + accepted: the federated sign-in that TRIGGERS a link still fails once with "Already found
 * an entry for username …" (an acknowledged Cognito limitation) — the app auto-retries that one
 * error silently (ui/src/main/auth/manager.ts), and the retry lands in the linked account.
 *
 * Failure posture: FAIL CLOSED. If ListUsers/linking errors, the sign-up is rejected (visible,
 * retryable) rather than silently proceeding into a forked second vault — under zero-knowledge a
 * fork can't be merged after the fact, so an opaque one-time failure is the cheaper wrong.
 */
import type { PreSignUpTriggerEvent } from "aws-lambda";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminLinkProviderForUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { decide, type ExistingUser } from "./decide.js";

const client = new CognitoIdentityProviderClient({});

const attr = (u: UserType, name: string): string | undefined =>
  u.Attributes?.find((a) => a.Name === name)?.Value;

/** ListUsers → the decision table's view of every OTHER profile holding this email. */
const existingUsersByEmail = async (userPoolId: string, email: string, selfUsername: string): Promise<ExistingUser[]> => {
  const res = await client.send(
    new ListUsersCommand({ UserPoolId: userPoolId, Filter: `email = "${email.replace(/"/g, "")}"` }),
  );
  return (res.Users ?? [])
    .filter((u) => u.Username !== undefined && u.Username.toLowerCase() !== selfUsername.toLowerCase())
    .map((u) => ({
      username: u.Username as string,
      status: u.UserStatus ?? "UNKNOWN",
      emailVerified: attr(u, "email_verified") === "true",
      // The `identities` attribute exists exactly on external-IdP profiles.
      federated: attr(u, "identities") !== undefined,
    }));
};

/** Link the incoming federated identity (event.userName = "<Provider>_<idp sub>") into `destination`. */
const linkInto = async (userPoolId: string, eventUserName: string, destinationUsername: string): Promise<void> => {
  const sep = eventUserName.indexOf("_");
  const provider = eventUserName.slice(0, sep);
  const idpSub = eventUserName.slice(sep + 1);
  if (sep <= 0 || idpSub.length === 0) throw new Error(`unexpected federated userName shape: ${eventUserName}`);
  await client.send(
    new AdminLinkProviderForUserCommand({
      UserPoolId: userPoolId,
      DestinationUser: { ProviderName: "Cognito", ProviderAttributeValue: destinationUsername },
      // Capitalized provider name from the userName prefix ("Google"), Cognito_Subject = the IdP's sub.
      SourceUser: { ProviderName: provider, ProviderAttributeName: "Cognito_Subject", ProviderAttributeValue: idpSub },
    }),
  );
};

export const handler = async (event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> => {
  const email = (event.request.userAttributes.email ?? "").trim().toLowerCase();
  if (!email) return event; // nothing to key on — let Cognito's own validation handle it

  const decision = decide({
    triggerSource: event.triggerSource,
    emailVerified: event.request.userAttributes.email_verified === "true",
    // Skip the ListUsers round trip when the decision can't need it (our own AdminCreateUser).
    existing:
      event.triggerSource === "PreSignUp_AdminCreateUser"
        ? []
        : await existingUsersByEmail(event.userPoolId, email, event.userName),
  });

  switch (decision.action) {
    case "proceed":
      return event;

    case "linkToExisting":
      await linkInto(event.userPoolId, event.userName, decision.destinationUsername);
      return event;

    case "createShellAndLink": {
      for (const stale of decision.deleteStaleUsernames) {
        await client.send(new AdminDeleteUserCommand({ UserPoolId: event.userPoolId, Username: stale }));
      }
      // Passwordless pool ⇒ a user created with NO password and a passwordless factor (email) is
      // born CONFIRMED — no temp password, no FORCE_CHANGE_PASSWORD dance. SUPPRESS: no invite
      // email; from the user's side this account simply is their Google account.
      const created = await client.send(
        new AdminCreateUserCommand({
          UserPoolId: event.userPoolId,
          Username: email,
          MessageAction: "SUPPRESS",
          UserAttributes: [
            { Name: "email", Value: email },
            // Verified by the IdP (decide() only reaches this branch on a verified claim) — and
            // required for this shell to serve EMAIL_OTP sign-ins + link as a trusted destination.
            { Name: "email_verified", Value: "true" },
          ],
        }),
      );
      const shellUsername = created.User?.Username;
      if (!shellUsername) throw new Error("AdminCreateUser returned no username for the shell user");
      await linkInto(event.userPoolId, event.userName, shellUsername);
      return event;
    }

    case "blockNativeSignUp":
      // Surfaces to the client as UserLambdaValidationException("PreSignUp failed with error <msg>")
      // — the app strips the wrapper and shows the message verbatim (auth/cognito-idp.ts).
      throw new Error(decision.message);
  }
};
