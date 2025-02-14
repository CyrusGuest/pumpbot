const express = require("express");
const db = require("../db/connection.js");
const {
  CognitoIdentityProviderClient,
  GetUserCommand,
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const crypto = require("crypto");

// Function to compute the secret hash
function generateSecretHash(username, clientId, clientSecret) {
  const hmac = crypto.createHmac("sha256", clientSecret);
  hmac.update(username + clientId);
  return hmac.digest("base64");
}

const router = express.Router();

router.post("/verify_token", async (req, res) => {
  const token = req.body.token;

  const params = {
    AccessToken: token,
  };

  try {
    const command = new GetUserCommand(params);
    const response = await client.send(command);

    // Token is valid, set the user in state or perform any other necessary actions
    const user = response.UserAttributes;
    res.status(200).json({ statusCode: 200, user });
  } catch (error) {
    console.log(error);
    // Token is invalid or expired, clear the token from local storage
    res.status(400).json({ statusCode: 400, error, user: null });
  }
});

router.post("/create_user", async (req, res) => {
  const userData = req.body;

  const secretHash = generateSecretHash(userData.email, clientId, clientSecret);

  const input = {
    ClientId: clientId,
    SecretHash: secretHash, // Required when using client secret
    Username: userData.email, // required
    Password: userData.password, // required
    UserAttributes: [
      {
        Name: "email", // required
        Value: userData.email,
      },
    ],
  };

  const command = new SignUpCommand(input);

  try {
    const response = await client.send(command);

    res.status(200).json({
      statusCode: 200,
      message: "Sign up successful",
      user: {
        sub: response.UserSub,
        email: userData.email,
      },
    });

    return response;
  } catch (error) {
    console.error("Error during sign-up:", error);

    res.status(400).json({ statusCode: 400, error: error.message });
  }
});

router.post("/signin", async (req, res) => {
  const { email, password } = req.body;

  const secretHash = generateSecretHash(email, clientId, clientSecret);

  // Input for InitiateAuthCommand
  const input = {
    AuthFlow: "USER_PASSWORD_AUTH", // Set the authentication flow to user-password-based auth
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password,
      SECRET_HASH: secretHash,
    },
    ClientId: clientId, // Your Cognito app client ID
  };

  const command = new InitiateAuthCommand(input);

  try {
    // Send the authentication request
    const response = await client.send(command);

    // Check if the response contains an AuthenticationResult
    if (response.AuthenticationResult) {
      const token = response.AuthenticationResult.AccessToken;

      // Now, use the token to get the user attributes
      const getUserCommand = new GetUserCommand({ AccessToken: token });
      const userResponse = await client.send(getUserCommand);

      const userAttributes = userResponse.UserAttributes;

      // Send back the access token and user information
      res.status(200).send({
        statusCode: 200,
        user: userAttributes,
        accessToken: token,
      });
    } else {
      // Handle cases where a challenge response is required (like MFA)
      res.status(400).send({
        statusCode: 400,
        message: "Additional challenge required",
        challenge: response.ChallengeName,
        session: response.Session,
      });
    }
  } catch (error) {
    // Handle authentication errors
    res.status(401).send({
      statusCode: 401,
      error: error.message,
    });
  }
});

router.post("/confirm_user", async (req, res) => {
  const { username, confirmationCode } = req.body;

  const secretHash = generateSecretHash(username, clientId, clientSecret);

  const input = {
    ClientId: clientId, // required, Cognito app client id
    SecretHash: secretHash, // required, computed secret hash
    Username: username, // required, from request body
    ConfirmationCode: confirmationCode, // required, from request body
    ForceAliasCreation: false, // set to true or false based on your use case
  };

  // Create the command
  const command = new ConfirmSignUpCommand(input);

  try {
    // Send the command to AWS Cognito
    const response = await client.send(command);

    // If successful, response will include confirmation details
    res.status(200).send({
      statusCode: 200,
      user: username,
      result: response,
    });
  } catch (error) {
    // Handle any errors
    console.error(error);
    res.status(400).send({
      statusCode: 400,
      user: null,
      error: error.message,
    });
  }
});

module.exports = router;
