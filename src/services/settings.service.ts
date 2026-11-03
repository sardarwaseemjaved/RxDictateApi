import type { Types } from 'mongoose';
import { Setting, type SettingDoc } from '../models';
import { AppError } from '../core/errors';
import { can } from '../core/permissions';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type { Scope } from '../core/db';
import {
  SETTING_KEYS,
  definitionOf,
  organisationActionOf,
  type SettingKey,
  type SettingLayer,
  type SettingSource,
  type SettingValue,
  type SettingsPatch,
  type SettingsView,
} from '../shared/settings';

/**
 * Settings, as the registry in src/shared/settings.ts defines them.
 *
 * Who is asking is always a person in an organisation: their own values are
 * theirs in that organisation, the organisation's apply to everyone in it,
 * and the platform's to everyone. Everything here works from the three sets
 * of rows that can apply, read in one query.
 */

/** Highest first. A lock at one of these beats every one after it. */
const LAYERS: readonly SettingLayer[] = ['platform', 'organisation', 'user'];

interface Who {
  organisationId: Types.ObjectId;
  userId: Types.ObjectId;
}

const whoFrom = (scope: Scope): Who => ({ organisationId: scope.practiceId, userId: scope.actorId });

/** The row a write at this layer touches, by who is writing. */
const target = (layer: SettingLayer, who: Who) => ({
  layer,
  organisationId: layer === 'platform' ? null : who.organisationId,
  userId: layer === 'user' ? who.userId : null,
});

/** Every row that can apply to this person in this organisation. */
const rowsFor = async (who: Who): Promise<SettingDoc[]> => Setting.find({ $or: LAYERS.map((layer) => target(layer, who)) });

/**
 * A layer's row for a key, if it counts: the registry still lets that layer
 * set it, and the stored value is one the key's schema still accepts. A value
 * left over from an older registry is as if nobody had set it.
 */
const counted = (rows: SettingDoc[], key: SettingKey, layer: SettingLayer): { value: unknown; locked: boolean } | null => {
  const definition = definitionOf(key);
  const row = rows.find((candidate) => candidate.key === key && candidate.layer === layer);
  if (!row || !definition.setBy.includes(layer)) {
    return null;
  }
  const parsed = definition.schema.safeParse(row.value);
  return parsed.success ? { value: parsed.data, locked: definition.lockable && row.locked } : null;
};

/** The highest layer that has locked this key, if any is above `below`. */
const lockAbove = (rows: SettingDoc[], key: SettingKey, below: SettingLayer): SettingLayer | null =>
  LAYERS.slice(0, LAYERS.indexOf(below)).find((layer) => counted(rows, key, layer)?.locked) ?? null;

/**
 * What applies: the highest lock if there is one, otherwise the lowest layer
 * that set a value, otherwise the default.
 */
const resolve = (rows: SettingDoc[], key: SettingKey): { value: unknown; source: SettingSource; locked: boolean } => {
  const locker = lockAbove(rows, key, 'user');
  if (locker) {
    return { value: counted(rows, key, locker)!.value, source: locker, locked: true };
  }
  const own = [...LAYERS].reverse().find((layer) => counted(rows, key, layer) !== null);
  if (own) {
    return { value: counted(rows, key, own)!.value, source: own, locked: false };
  }
  return { value: definitionOf(key).default, source: 'default', locked: false };
};

const viewFrom = (rows: SettingDoc[]): SettingsView =>
  Object.fromEntries(SETTING_KEYS.map((key) => [key, resolve(rows, key)])) as SettingsView;

/** GET /settings: every key, as it applies to this person in this organisation. */
export const getSettings = async (scope: Scope): Promise<SettingsView> => viewFrom(await rowsFor(whoFrom(scope)));

/**
 * What applies to a whole clinic, for when nobody in it is asking: a patient
 * opening a record, or an approval deciding whether to send an invite. Only for
 * a key no person sets for themselves.
 */
export const organisationSetting = async <K extends SettingKey>(
  organisationId: Types.ObjectId,
  key: K,
): Promise<SettingValue<K>> => {
  const rows = await Setting.find({
    key,
    $or: [
      { layer: 'platform', organisationId: null, userId: null },
      { layer: 'organisation', organisationId, userId: null },
    ],
  });
  return resolve(rows, key).value as SettingValue<K>;
};

const LOCKED_BY: Record<SettingLayer, string> = {
  platform: 'is locked by RxDictate',
  organisation: 'is locked by your clinic',
  user: 'is locked',
};

const AUDIT_ACTION: Record<SettingLayer, string> = {
  platform: 'settings.platform.update',
  organisation: 'settings.organisation.update',
  user: 'settings.user.update',
};

/** What a layer holds for one key, as the audit log records it. */
const held = (key: SettingKey, row: { value: unknown; locked: boolean } | null) =>
  row ? { key, value: row.value, locked: row.locked } : null;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * One write at one layer: refuse anything a higher layer has locked, then set
 * or take away each key, then audit and announce what actually changed.
 *
 * Taking a value away is allowed even under a lock, because it cannot
 * contradict one: what applies stays what the lock says.
 */
const write = async (
  scope: Scope & { requestId?: string | null },
  layer: SettingLayer,
  { values }: SettingsPatch,
): Promise<SettingsView> => {
  const who = whoFrom(scope);
  const rows = await rowsFor(who);

  const refused = values
    .map((change, index) => ({ index, locker: change.value === null ? null : lockAbove(rows, change.key, layer) }))
    .filter((check): check is { index: number; locker: SettingLayer } => check.locker !== null)
    .map(({ index, locker }) => ({ field: `body.values.${index}.key`, message: LOCKED_BY[locker] }));
  if (refused.length > 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      refused.map((detail) => `${detail.field}: ${detail.message}`).join(', '),
      refused,
    );
  }

  const where = target(layer, who);
  const changes = await Promise.all(
    values.map(async ({ key, value, locked }) => {
      const old = rows.find((row) => row.key === key && row.layer === layer) ?? null;
      let next: { value: unknown; locked: boolean } | null = null;

      if (value === null) {
        if (old) {
          await Setting.deleteOne({ _id: old._id });
        }
      } else {
        next = { value, locked: locked ?? old?.locked ?? false };
        await Setting.findOneAndUpdate(
          { ...where, key },
          { $set: { value: next.value, locked: next.locked, updatedBy: scope.actorId } },
          { upsert: true },
        );
      }

      return { key, before: held(key, old), after: held(key, next) };
    }),
  );

  const changed = changes.filter((change) => !same(change.before, change.after));
  if (changed.length > 0) {
    const keys = changed.map((change) => change.key);
    // Lists, not objects keyed by setting: a key has a dot in it.
    await writeAudit(scope, {
      action: AUDIT_ACTION[layer],
      entity: 'setting',
      before: changed.map((change) => change.before).filter(Boolean),
      after: changed.map((change) => change.after).filter(Boolean),
      requestId: scope.requestId ?? null,
    });

    if (layer === 'user') {
      emit('settings.changed', { layer, ...who, keys, actorId: scope.actorId });
    } else if (layer === 'organisation') {
      emit('settings.changed', { layer, organisationId: who.organisationId, keys, actorId: scope.actorId });
    } else {
      emit('settings.changed', { layer, keys, actorId: scope.actorId });
    }
  }

  return viewFrom(await rowsFor(who));
};

/** PATCH /settings/me: this person's own values, in this organisation. */
export const updateUserSettings = async (
  scope: Scope & { requestId?: string | null },
  patch: SettingsPatch,
): Promise<SettingsView> => write(scope, 'user', patch);

/**
 * PATCH /settings/organisation: the clinic's values and locks, for everyone in
 * it. Each key names the action that sets it, so a medicine manager can set the
 * clinic's medicine mode and nothing else. One key they may not set refuses the
 * whole patch.
 */
export const updateOrganisationSettings = async (
  scope: Scope & { requestId?: string | null },
  patch: SettingsPatch,
): Promise<SettingsView> => {
  if (!patch.values.every(({ key }) => can(scope.role, organisationActionOf(key)))) {
    throw new AppError('FORBIDDEN', 'You cannot change that setting for this clinic.');
  }
  return write(scope, 'organisation', patch);
};

/** PATCH /settings/platform: values and locks for every organisation. */
export const updatePlatformSettings = async (
  scope: Scope & { requestId?: string | null },
  patch: SettingsPatch,
): Promise<SettingsView> => write(scope, 'platform', patch);

export default { getSettings, organisationSetting, updateUserSettings, updateOrganisationSettings, updatePlatformSettings };
