import { describe, expect, test } from "bun:test";
import { messageFor } from "./messages.js";

describe("messageFor", () => {
  test("the two sources our pool produces get their own copy", () => {
    const signUp = messageFor("CustomEmailSender_SignUp");
    const auth = messageFor("CustomEmailSender_Authentication");
    expect(signUp).not.toBeNull();
    expect(auth).not.toBeNull();
    // A first account and a returning sign-in are different moments — same template, different words.
    expect(signUp?.intro).not.toBe(auth?.intro);
    expect(auth?.subject).toBe("Your ColdStorage sign-in code");
  });

  test("every source is unhandled unless we said otherwise — an unhandled one must not send", () => {
    // Cognito's full trigger-source list minus the two above. Each of these would be a dropped email
    // if messageFor invented copy for it, so null (→ the handler throws) is the required answer.
    for (const source of [
      "CustomEmailSender_ForgotPassword",
      "CustomEmailSender_ResendCode",
      "CustomEmailSender_UpdateUserAttribute",
      "CustomEmailSender_VerifyUserAttribute",
      "CustomEmailSender_AdminCreateUser",
      "CustomEmailSender_AccountTakeOverNotification",
      "",
    ]) {
      expect(messageFor(source)).toBeNull();
    }
  });

  test("no message leaks the code into the preheader — it renders on lock screens", () => {
    for (const source of ["CustomEmailSender_SignUp", "CustomEmailSender_Authentication"]) {
      const message = messageFor(source);
      expect(message?.preheader).not.toMatch(/\d/);
    }
  });
});
