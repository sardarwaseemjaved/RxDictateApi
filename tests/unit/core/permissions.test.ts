import { actionsFor, can } from '../../../src/core/permissions';
import { ACTIONS, ROLES_BY_ORGANISATION_TYPE, roleSchema } from '../../../src/shared/roles';

describe('The permissions table', () => {
  /** The table in the spec, read straight across. */
  const expectations: [string, 'doctor' | 'pa', boolean][] = [
    ['patient.create', 'doctor', true],
    ['patient.create', 'pa', true],
    ['patient.update', 'doctor', true],
    ['patient.update', 'pa', true],
    ['patient.search', 'doctor', true],
    ['patient.search', 'pa', true],
    ['visit.read', 'doctor', true],
    ['visit.read', 'pa', true],

    ['prescription.create', 'doctor', true],
    ['prescription.create', 'pa', false],
    ['prescription.update', 'pa', false],
    ['prescription.approve', 'pa', false],
    ['prescription.read', 'pa', true],
    ['prescription.print', 'pa', true],

    ['voice.dictate', 'doctor', true],
    ['voice.dictate', 'pa', false],

    ['member.add', 'doctor', true],
    ['member.add', 'pa', false],
    ['member.remove', 'pa', false],
    ['member.update', 'pa', false],

    ['location.create', 'doctor', true],
    ['location.create', 'pa', false],
    ['location.update', 'pa', false],
    ['location.archive', 'pa', false],
    ['practice.update', 'doctor', true],
    ['practice.update', 'pa', false],

    ['patient.history', 'doctor', true],
    ['patient.history', 'pa', false],

    ['report.create', 'pa', true],
    ['report.review', 'doctor', true],
    ['report.review', 'pa', false],

    ['template.read', 'doctor', true],
    ['template.create', 'doctor', true],
    ['template.update', 'doctor', true],
    ['template.delete', 'doctor', true],
    ['template.read', 'pa', false],
    ['template.create', 'pa', false],
    ['template.update', 'pa', false],
    ['template.delete', 'pa', false],
  ];

  test.each(expectations)('%s for a %s is %s', (action, role, allowed) => {
    expect(can(role, action as (typeof ACTIONS)[number])).toBe(allowed);
  });

  test('every action has an entry, so a new one cannot be forgotten', () => {
    ACTIONS.forEach((action) => {
      expect(typeof can('doctor', action)).toBe('boolean');
      expect(typeof can('pa', action)).toBe('boolean');
    });
  });

  test('a patient holds nothing until the portal exists', () => {
    expect(actionsFor('patient')).toEqual([]);
  });

  test('a doctor can do everything a PA can', () => {
    actionsFor('pa').forEach((action) => {
      expect(can('doctor', action)).toBe(true);
    });
  });

  describe('settings and the platform', () => {
    test('everybody who works somewhere reads settings; a patient still holds nothing', () => {
      ['doctor', 'pa', 'platformAdmin', 'reviewer', 'contentManager'].forEach((role) => {
        expect(can(role as 'doctor', 'settings.read')).toBe(true);
      });
      expect(can('patient', 'settings.read')).toBe(false);
    });

    test("a clinic's doctor sets the clinic's settings, and only a platform admin sets the platform's", () => {
      expect(ACTIONS.filter((action) => action.startsWith('settings.')).length).toBe(3);
      expect(roleSchema.options.filter((role) => can(role, 'settings.organisation.update'))).toEqual(['doctor']);
      expect(roleSchema.options.filter((role) => can(role, 'settings.platform.update'))).toEqual(['platformAdmin']);
    });

    test("the platform's roles hold none of a clinic's actions", () => {
      expect(actionsFor('platformAdmin')).toEqual(['settings.read', 'settings.platform.update']);
      expect(actionsFor('reviewer')).toEqual(['settings.read']);
      expect(actionsFor('contentManager')).toEqual(['settings.read']);
    });

    test('every role belongs to exactly one kind of organisation, and a company has none yet', () => {
      roleSchema.options.forEach((role) => {
        const holders = Object.values(ROLES_BY_ORGANISATION_TYPE).filter((roles) => roles.includes(role));
        expect({ role, kinds: holders.length }).toEqual({ role, kinds: 1 });
      });
      expect(ROLES_BY_ORGANISATION_TYPE.company).toEqual([]);
    });
  });
});
