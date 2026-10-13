import config from '../../config/config';
import logger from '../../config/logger';

export interface SmsProvider {
  readonly name: string;
  send(to: string, body: string): Promise<void>;
}

/**
 * Only the last three digits, because a phone number identifies a person and
 * the application log is not the place for that. The audit log holds the rest.
 */
const maskPhone = (phone: string): string => `***${phone.slice(-3)}`;

/**
 * The only provider wired up so far. It records that a message was sent and to
 * whom, masked, and never the body: a sign-in code in a log file is a sign-in
 * code anyone with log access can use.
 *
 * A real gateway is a second implementation of this interface and a case in the
 * switch below. Nothing else in the codebase changes.
 */
const logProvider: SmsProvider = {
  name: 'log',
  async send(to: string): Promise<void> {
    logger.info(`sms to ${maskPhone(to)} queued via log provider`);
  },
};

const providers: Record<typeof config.sms.provider, SmsProvider> = {
  log: logProvider,
};

export const provider = (): SmsProvider => providers[config.sms.provider];

/**
 * A failed SMS must not fail the write that caused it. The doctor adding a PA
 * has still added her; she can sign in whether or not the text arrived.
 */
const sendQuietly = async (to: string, body: string, what: string): Promise<void> => {
  try {
    await provider().send(to, body);
  } catch (error) {
    logger.warn(`could not send ${what} to ${maskPhone(to)}: ${(error as Error).message}`);
  }
};

export const sendOtp = async (phone: string, code: string): Promise<void> => {
  await sendQuietly(
    phone,
    `${code} is your ${config.sms.senderId} sign-in code. It expires in ${config.otp.expirationMinutes} minutes.`,
    'sign-in code',
  );
};

export const sendMemberAdded = async (phone: string, practiceName: string, role: string): Promise<void> => {
  await sendQuietly(
    phone,
    `You have been added to ${practiceName} as ${role}. Open the app and sign in with this number.`,
    'member invitation',
  );
};

export default { provider, sendOtp, sendMemberAdded };
