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
 * The only provider wired up so far.
 *
 * Outside production it logs the whole message, so an invitation can be read
 * and checked on a dev box with no gateway - the same bargain the sign-in code
 * is already under. In production it logs that something was sent and to whom,
 * masked, and never what: a message in a log file is a message anybody with
 * log access has read.
 *
 * A real gateway is a second implementation of this interface and a case in
 * the map below. Nothing else in the codebase changes.
 */
const logProvider: SmsProvider = {
  name: 'log',
  async send(to: string, body: string): Promise<void> {
    if (config.isProduction) {
      logger.info(`sms to ${maskPhone(to)} queued via log provider`);
      return;
    }
    logger.info(`[dev] sms to ${maskPhone(to)}: ${body}`);
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

/** A doctor who has already typed "Dr" into their name should not be Dr Dr. */
const asDoctor = (name: string): string => {
  const trimmed = name.trim();
  return trimmed ? `${/^dr\b\.?/i.test(trimmed) ? '' : 'Dr. '}${trimmed}` : '';
};

/**
 * Told to the person who was added, not to the person who added them.
 *
 * Named after whoever added them, because "you have been added to a clinic" by
 * nobody in particular reads like spam, and this arrives unprompted on the
 * phone of somebody who may not be expecting it. Deliberately says nothing
 * about the role: that is the clinic's business and not the mobile network's.
 */
export const sendMemberAdded = async (phone: string, addedByName: string, practiceName: string): Promise<void> => {
  const who = asDoctor(addedByName);

  const opening = who ? `${who} added you to ${practiceName}.` : `You have been added to ${practiceName}.`;

  await sendQuietly(phone, `${opening} Install ${config.sms.appName} and sign in with this number.`, 'member invitation');
};

/**
 * To someone a company or RxDictate has added to its staff. Names the
 * organisation, not whoever added them - they are not a doctor, and "Dr." in
 * front of a company admin's name would be wrong - and never the role.
 */
export const sendOrganisationMemberAdded = async (phone: string, organisationName: string): Promise<void> => {
  await sendQuietly(
    phone,
    `You have been added to ${organisationName} on ${config.sms.appName}. Sign in with this number.`,
    'member invitation',
  );
};

/**
 * An invite to see a record online. Names the clinic and the doctor, and never
 * the patient, a medicine or a diagnosis: a phone is often the whole family's,
 * and a message on it is read by whoever picks it up.
 */
export const sendPortalInvite = async (
  phone: string,
  doctorName: string,
  practiceName: string,
  link: string,
  hasPrescription: boolean,
): Promise<void> => {
  const who = asDoctor(doctorName);
  const from = who ? `${who} at ${practiceName}` : practiceName;
  const what = hasPrescription ? 'your prescription is ready to view' : 'you can now view your records online';

  await sendQuietly(phone, `${from}: ${what}. Get ${config.sms.appName} and sign in with this number: ${link}`, 'invite');
};

export default { provider, sendOtp, sendMemberAdded, sendOrganisationMemberAdded, sendPortalInvite };
