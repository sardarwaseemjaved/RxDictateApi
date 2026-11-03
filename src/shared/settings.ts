import { z } from 'zod';
import type { Action } from './roles';

/**
 * Every setting, in one registry, set at up to three layers:
 *
 *   platform (RxDictate, for everyone) -> organisation (a clinic) -> user (one person in that clinic)
 *
 * What applies is worked out by the server and nowhere else: the user's own
 * value, then the organisation's, then the platform's, then the default. A
 * higher layer may lock a lockable setting, and a lock beats every layer
 * below it. GET /settings answers each value with where it came from and
 * whether it is locked, so a screen can be drawn from this file alone.
 *
 * A new setting is one entry here and needs no route.
 */
export const settingLayerSchema = z.enum(['platform', 'organisation', 'user']);
export type SettingLayer = z.infer<typeof settingLayerSchema>;

/** Where a value came from: one of the layers, or nobody set it. */
export const settingSourceSchema = z.enum(['default', 'platform', 'organisation', 'user']);
export type SettingSource = z.infer<typeof settingSourceSchema>;

export interface SettingDefinition<T extends z.ZodType = z.ZodType> {
  /** What a value must be, at any layer. */
  schema: T;
  /** What applies when no layer has set it. */
  default: z.output<T>;
  /** Which layers may set it. */
  setBy: readonly SettingLayer[];
  /** Whether a layer that sets it may also stop the layers below from changing it. */
  lockable: boolean;
  /** The action that sets it at the organisation layer, when it is not `settings.organisation.update`. */
  organisationAction?: Action;
}

/** Only here so each entry's default is checked against its own schema. */
const setting = <T extends z.ZodType>(definition: SettingDefinition<T>): SettingDefinition<T> => definition;

export const SETTINGS = {
  /**
   * Where medicine suggestions come from while writing a prescription:
   * - `myList`: only the doctor's and the clinic's own lists;
   * - `myListFirst`: those first, then everything else;
   * - `all`: everything, ranked by use.
   */
  'medicines.source': setting({
    schema: z.enum(['myList', 'myListFirst', 'all']),
    default: 'myListFirst',
    setBy: ['platform', 'organisation', 'user'],
    lockable: true,
    organisationAction: 'drugList.clinic.manage',
  }),
  /** Whether this clinic's patients can link and see their records at all. Off means links stay and serve nothing. */
  'portal.enabled': setting({
    schema: z.boolean(),
    default: false,
    setBy: ['platform', 'organisation'],
    lockable: true,
  }),
  /**
   * How invites go out, since an SMS costs money:
   * - `manual`: only when staff send one;
   * - `auto`: also after a patient's first approved prescription, once per patient.
   */
  'portal.invites': setting({
    schema: z.enum(['auto', 'manual']),
    default: 'manual',
    setBy: ['platform', 'organisation'],
    lockable: true,
  }),
};

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]['schema']>;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const settingKeySchema = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]);

export const isSettingKey = (key: string): key is SettingKey => Object.prototype.hasOwnProperty.call(SETTINGS, key);

/** The registry entry for a key, without the per-key types. */
export const definitionOf = (key: SettingKey): SettingDefinition => SETTINGS[key];

/** Who may set this key for a clinic. */
export const organisationActionOf = (key: SettingKey): Action =>
  definitionOf(key).organisationAction ?? 'settings.organisation.update';

/** Every action that sets something for a clinic: holding none of them, a member can set nothing there. */
export const ORGANISATION_SETTING_ACTIONS: readonly Action[] = [
  ...new Set<Action>(['settings.organisation.update', ...SETTING_KEYS.map(organisationActionOf)]),
];

/** One setting as it applies to the caller. */
export interface EffectiveSetting<K extends SettingKey> {
  value: SettingValue<K>;
  source: SettingSource;
  /** True when a layer above the one it came from cannot be overruled: a lock decided it. */
  locked: boolean;
}

/** GET /settings: every key in the registry, for the active membership. */
export type SettingsView = { [K in SettingKey]: EffectiveSetting<K> };

export const settingsViewSchema = z.object(
  Object.fromEntries(
    SETTING_KEYS.map((key) => [
      key,
      z.object({ value: definitionOf(key).schema, source: settingSourceSchema, locked: z.boolean() }),
    ]),
  ),
) as unknown as z.ZodType<SettingsView>;

/**
 * One change at one layer, in a PATCH body's `values`:
 *
 * - `{ key, value }` sets it;
 * - `{ key, value, locked: true }` sets it and stops the layers below from
 *   changing it, on a lockable key at the platform or organisation layer.
 *   Leaving `locked` out keeps the lock as it was;
 * - `{ key, value: null }` takes this layer's value (and its lock) away, so
 *   what applies above shows through.
 *
 * A list rather than an object keyed by setting, because a setting's key has a
 * dot in it and the API strips dotted keys from every request body.
 */
export type SettingChange = { [K in SettingKey]: { key: K; value: SettingValue<K> | null; locked?: boolean } }[SettingKey];

/** PATCH /settings/me, /settings/organisation and /settings/platform. */
export interface SettingsPatch {
  values: SettingChange[];
}

const WHO_SETS: Record<SettingLayer, string> = {
  platform: 'for everyone',
  organisation: 'by a clinic',
  user: 'by a person for themselves',
};

/** A person's own values cannot be locked: there is nobody below them. */
const changeShape = (layer: SettingLayer) =>
  layer === 'user'
    ? z.strictObject({ key: z.string(), value: z.unknown() })
    : z.strictObject({ key: z.string(), value: z.unknown(), locked: z.boolean().optional() });

/**
 * A patch for one layer: each key named once, in the registry, settable at
 * this layer, and with a value its schema accepts. Each problem is reported
 * against its own change, so a settings screen can put the message next to
 * the right control.
 */
const patchSchema = (layer: SettingLayer) =>
  z
    .strictObject({ values: z.array(changeShape(layer)).min(1, 'nothing to change') })
    .superRefine((body, ctx) => {
      body.values.forEach((change: { key: string; value: unknown; locked?: boolean }, index) => {
        const at = ['values', index];
        if (!isSettingKey(change.key)) {
          ctx.addIssue({ code: 'custom', path: [...at, 'key'], message: 'is not a setting' });
          return;
        }
        if (body.values.findIndex((other) => other.key === change.key) !== index) {
          ctx.addIssue({ code: 'custom', path: [...at, 'key'], message: 'is named more than once' });
          return;
        }
        const definition = definitionOf(change.key);
        if (!definition.setBy.includes(layer)) {
          ctx.addIssue({ code: 'custom', path: [...at, 'key'], message: `cannot be set ${WHO_SETS[layer]}` });
          return;
        }
        if (change.locked && !definition.lockable) {
          ctx.addIssue({ code: 'custom', path: [...at, 'locked'], message: 'cannot be locked' });
        }
        if (change.value === null) {
          if (change.locked) {
            ctx.addIssue({ code: 'custom', path: [...at, 'locked'], message: 'needs a value to lock' });
          }
          return;
        }
        const parsed = definition.schema.safeParse(change.value);
        if (!parsed.success) {
          parsed.error.issues.forEach((issue) => {
            ctx.addIssue({ code: 'custom', path: [...at, 'value', ...issue.path], message: issue.message });
          });
        }
      });
    })
    .transform((body) => ({
      values: body.values.map((change) => ({
        ...change,
        value: change.value === null ? null : definitionOf(change.key as SettingKey).schema.parse(change.value),
      })),
    }));

export const updateUserSettingsBodySchema = patchSchema('user') as unknown as z.ZodType<SettingsPatch>;
export const updateOrganisationSettingsBodySchema = patchSchema('organisation') as unknown as z.ZodType<SettingsPatch>;
export const updatePlatformSettingsBodySchema = patchSchema('platform') as unknown as z.ZodType<SettingsPatch>;
