const dotenv = require('dotenv');
const path = require('path');
const Joi = require('joi');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test').required(),
    PORT: Joi.number().default(3000),
    MONGODB_URL: Joi.string().required().description('Mongo DB url'),
    JWT_SECRET: Joi.string().required().description('JWT secret key'),
    JWT_ACCESS_EXPIRATION_MINUTES: Joi.number().default(30).description('minutes after which access tokens expire'),
    JWT_REFRESH_EXPIRATION_DAYS: Joi.number().default(30).description('days after which refresh tokens expire'),
    JWT_RESET_PASSWORD_EXPIRATION_MINUTES: Joi.number()
      .default(10)
      .description('minutes after which reset password token expires'),
    JWT_VERIFY_EMAIL_EXPIRATION_MINUTES: Joi.number()
      .default(10)
      .description('minutes after which verify email token expires'),
    PASSCODE_EXPIRATION_MINUTES: Joi.number().default(10).description('minutes after which a login passcode expires'),
    PASSCODE_MAX_ATTEMPTS: Joi.number().default(5).description('wrong guesses allowed before a passcode is burned'),
    PASSCODE_LOG_IN_DEV: Joi.boolean()
      .default(true)
      .description('in development, log each passcode and return it as devPassCode'),
    // Email is optional: a blank value means "no SMTP configured" rather than a
    // config error, so the API boots on a machine that cannot send mail.
    SMTP_HOST: Joi.string().allow('').description('server that will send the emails'),
    SMTP_PORT: Joi.number().allow('').description('port to connect to the email server'),
    SMTP_USERNAME: Joi.string().allow('').description('username for email server'),
    SMTP_PASSWORD: Joi.string().allow('').description('password for email server'),
    EMAIL_FROM: Joi.string().allow('').description('the from field in the emails sent by the app'),
  })
  .unknown();

const { value: envVars, error } = envVarsSchema.prefs({ errors: { label: 'key' } }).validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

module.exports = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  mongoose: {
    url: envVars.MONGODB_URL + (envVars.NODE_ENV === 'test' ? '-test' : ''),
    options: {
      useCreateIndex: true,
      useNewUrlParser: true,
      useUnifiedTopology: true,
    },
  },
  jwt: {
    secret: envVars.JWT_SECRET,
    accessExpirationMinutes: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: envVars.JWT_REFRESH_EXPIRATION_DAYS,
    resetPasswordExpirationMinutes: envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    verifyEmailExpirationMinutes: envVars.JWT_VERIFY_EMAIL_EXPIRATION_MINUTES,
  },
  passcode: {
    expirationMinutes: envVars.PASSCODE_EXPIRATION_MINUTES,
    maxAttempts: envVars.PASSCODE_MAX_ATTEMPTS,
    // Outside development this stays false regardless of the env var, so a
    // passcode is never returned to the caller in production.
    exposeInResponse: envVars.NODE_ENV === 'development' && envVars.PASSCODE_LOG_IN_DEV,
  },
  email: {
    smtp: {
      host: envVars.SMTP_HOST,
      port: envVars.SMTP_PORT,
      auth: {
        user: envVars.SMTP_USERNAME,
        pass: envVars.SMTP_PASSWORD,
      },
    },
    from: envVars.EMAIL_FROM,
  },
};
