import type { FilterQuery, HydratedDocument, Model, Types, UpdateQuery } from 'mongoose';
import type { PaginateModel, PaginateOptions, QueryResult } from '../../models/plugins';
import type { Role } from '../../shared/roles';
import { AppError } from '../errors';

/**
 * Who is asking and what they are allowed to see. Built once per request by
 * resolvePractice and resolveLocation.
 */
export interface Scope {
  practiceId: Types.ObjectId;
  actorId: Types.ObjectId;
  role: Role;
  /** A list for a PA, 'all' for a doctor, who may use any location of his practice. */
  allowedLocationIds: Types.ObjectId[] | 'all';
  /** The one location this request is about, from X-Location-Id. */
  locationId?: Types.ObjectId;
}

export interface RepositoryOptions {
  /** False only for collections that are not a tenant's data: users, drugs. */
  practiceScoped?: boolean;
  /** True for visits, prescriptions and voice, which also filter by location. */
  locationScoped?: boolean;
  /** False for append-only and infrastructure collections. */
  softDelete?: boolean;
}

export interface ReadOptions {
  /** Deliberately include soft-deleted rows. Only an audit or a repair needs this. */
  includeDeleted?: boolean;
}

/**
 * The one place the practiceId filter is applied.
 *
 * Every read and every write in the product goes through a repository, so no
 * route and no service has to remember the filter. One forgotten `.find()`
 * leaks another clinic's patient records, and the way to make that impossible
 * is to have exactly one function that can build a query.
 *
 * Soft delete is applied here for the same reason: nothing clinical is ever
 * hard-deleted, and a caller who wants the deleted rows has to say so.
 */
export class BaseRepository<T> {
  readonly model: Model<T>;
  private readonly options: Required<RepositoryOptions>;

  constructor(model: Model<T>, options: RepositoryOptions = {}) {
    this.model = model;
    this.options = {
      practiceScoped: options.practiceScoped ?? true,
      locationScoped: options.locationScoped ?? false,
      softDelete: options.softDelete ?? true,
    };
  }

  /**
   * Turn a caller's filter into one that cannot reach outside its practice.
   *
   * The scoping keys are applied last, so a filter that tries to set its own
   * practiceId is overwritten rather than honoured.
   */
  scopedFilter(scope: Scope, filter: FilterQuery<T> = {}, options: ReadOptions = {}): FilterQuery<T> {
    const scoped: Record<string, unknown> = { ...(filter as Record<string, unknown>) };

    if (this.options.practiceScoped) {
      scoped.practiceId = scope.practiceId;
    }

    if (this.options.locationScoped) {
      if (scope.locationId) {
        scoped.locationId = scope.locationId;
      } else if (Array.isArray(scope.allowedLocationIds)) {
        // No location was named, so a PA sees exactly the locations she was
        // assigned and nothing else. A doctor ('all') gets no constraint.
        scoped.locationId = { $in: scope.allowedLocationIds };
      }
    }

    if (this.options.softDelete && !options.includeDeleted) {
      scoped.deletedAt = null;
    }

    return scoped as FilterQuery<T>;
  }

  /** The practiceId, locationId and createdBy stamped onto anything new. */
  private stamp(scope: Scope): Record<string, unknown> {
    const fields: Record<string, unknown> = { createdBy: scope.actorId };
    if (this.options.practiceScoped) {
      fields.practiceId = scope.practiceId;
    }
    if (this.options.locationScoped) {
      if (!scope.locationId) {
        throw new AppError('LOCATION_REQUIRED', `${this.model.modelName} is location-scoped and needs X-Location-Id`);
      }
      fields.locationId = scope.locationId;
    }
    return fields;
  }

  async findOne(scope: Scope, filter: FilterQuery<T> = {}, options: ReadOptions = {}): Promise<HydratedDocument<T> | null> {
    return this.model.findOne(this.scopedFilter(scope, filter, options));
  }

  async findById(scope: Scope, id: Types.ObjectId | string, options: ReadOptions = {}): Promise<HydratedDocument<T> | null> {
    return this.findOne(scope, { _id: id } as FilterQuery<T>, options);
  }

  /** findById, but a miss is a 404 rather than a null the caller has to remember to check. */
  async findByIdOrFail(scope: Scope, id: Types.ObjectId | string, what: string): Promise<HydratedDocument<T>> {
    const found = await this.findById(scope, id);
    if (!found) {
      throw AppError.notFound(what);
    }
    return found;
  }

  async find(
    scope: Scope,
    filter: FilterQuery<T> = {},
    options: ReadOptions & { sort?: Record<string, 1 | -1>; limit?: number } = {},
  ): Promise<HydratedDocument<T>[]> {
    let query = this.model.find(this.scopedFilter(scope, filter, options));
    if (options.sort) {
      query = query.sort(options.sort);
    }
    if (options.limit) {
      query = query.limit(options.limit);
    }
    return query.exec();
  }

  async count(scope: Scope, filter: FilterQuery<T> = {}, options: ReadOptions = {}): Promise<number> {
    return this.model.countDocuments(this.scopedFilter(scope, filter, options));
  }

  async paginate(
    scope: Scope,
    filter: FilterQuery<T> = {},
    options: PaginateOptions & ReadOptions = {},
  ): Promise<QueryResult<HydratedDocument<T>>> {
    const model = this.model as PaginateModel<T>;
    return model.paginate(this.scopedFilter(scope, filter, options), options);
  }

  async create(scope: Scope, data: Partial<T> & Record<string, unknown>): Promise<HydratedDocument<T>> {
    const created = await this.model.create({ ...data, ...this.stamp(scope) });
    return created as HydratedDocument<T>;
  }

  /** Scoped update by id. Returns null when the id is not in this practice. */
  async updateById(scope: Scope, id: Types.ObjectId | string, update: UpdateQuery<T>): Promise<HydratedDocument<T> | null> {
    return this.model.findOneAndUpdate(this.scopedFilter(scope, { _id: id } as FilterQuery<T>), update, { new: true });
  }

  /**
   * Stamp deletedAt. There is no hard delete on this class on purpose: a
   * clinical record that is gone is a record that cannot be explained to a
   * patient or a regulator.
   */
  async softDeleteById(scope: Scope, id: Types.ObjectId | string): Promise<HydratedDocument<T> | null> {
    if (!this.options.softDelete) {
      throw new AppError('INTERNAL', `${this.model.modelName} does not support soft delete`, undefined, false);
    }
    return this.updateById(scope, id, { $set: { deletedAt: new Date() } } as UpdateQuery<T>);
  }
}

export default BaseRepository;
