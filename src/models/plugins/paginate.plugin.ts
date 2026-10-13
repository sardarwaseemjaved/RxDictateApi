/* eslint-disable no-param-reassign, @typescript-eslint/no-explicit-any, func-names */
import type { FilterQuery, HydratedDocument, Model, Schema } from 'mongoose';

export interface PaginateOptions {
  /** Sorting criteria using the format: sortField:(desc|asc), comma separated. */
  sortBy?: string;
  /** Populate data fields; hierarchy separated by (.), criteria separated by commas. */
  populate?: string;
  limit?: number | string;
  page?: number | string;
}

export interface QueryResult<T> {
  results: T[];
  page: number;
  limit: number;
  totalPages: number;
  totalResults: number;
}

export interface PaginateModel<T> extends Model<T> {
  paginate(filter: FilterQuery<T>, options: PaginateOptions): Promise<QueryResult<HydratedDocument<T>>>;
}

const paginate = (schema: Schema): void => {
  schema.statics.paginate = async function (filter: FilterQuery<any>, options: PaginateOptions) {
    let sort = '';
    if (options.sortBy) {
      const sortingCriteria: string[] = [];
      options.sortBy.split(',').forEach((sortOption) => {
        const [key, order] = sortOption.split(':');
        sortingCriteria.push((order === 'desc' ? '-' : '') + key);
      });
      sort = sortingCriteria.join(' ');
    } else {
      sort = 'createdAt';
    }

    const limit = options.limit && parseInt(String(options.limit), 10) > 0 ? parseInt(String(options.limit), 10) : 10;
    const page = options.page && parseInt(String(options.page), 10) > 0 ? parseInt(String(options.page), 10) : 1;
    const skip = (page - 1) * limit;

    const countPromise = this.countDocuments(filter).exec();
    let docsPromise = this.find(filter).sort(sort).skip(skip).limit(limit);

    if (options.populate) {
      options.populate.split(',').forEach((populateOption) => {
        const populateArg = populateOption
          .split('.')
          .reverse()
          .reduce<any>((nested, field) => ({ path: field, populate: nested }), undefined);
        docsPromise = docsPromise.populate(populateArg);
      });
    }

    const [totalResults, results] = await Promise.all([countPromise, docsPromise.exec()]);
    const totalPages = Math.ceil(totalResults / limit);
    return { results, page, limit, totalPages, totalResults };
  };
};

export default paginate;
