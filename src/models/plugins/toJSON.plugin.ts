/* eslint-disable no-param-reassign, @typescript-eslint/no-explicit-any */
import type { Schema } from 'mongoose';

/**
 * A mongoose schema plugin which applies the following in the toJSON transform call:
 *  - removes __v, createdAt, updatedAt, and any path that has private: true
 *  - replaces _id with id
 */
const deleteAtPath = (obj: any, path: string[], index: number): void => {
  if (index === path.length - 1) {
    delete obj[path[index]];
    return;
  }
  if (obj[path[index]] === undefined || obj[path[index]] === null) {
    return;
  }
  deleteAtPath(obj[path[index]], path, index + 1);
};

const toJSON = (schema: Schema): void => {
  let transform: ((doc: any, ret: any, options: any) => any) | undefined;
  if (schema.options.toJSON && (schema.options.toJSON as any).transform) {
    transform = (schema.options.toJSON as any).transform;
  }

  schema.options.toJSON = Object.assign(schema.options.toJSON || {}, {
    transform(doc: any, ret: any, options: any) {
      Object.keys(schema.paths).forEach((path) => {
        const schemaPath = schema.paths[path] as any;
        if (schemaPath.options && schemaPath.options.private) {
          deleteAtPath(ret, path.split('.'), 0);
        }
      });

      ret.id = ret._id.toString();
      delete ret._id;
      delete ret.__v;
      delete ret.createdAt;
      delete ret.updatedAt;
      if (transform) {
        return transform(doc, ret, options);
      }
    },
  });
};

export default toJSON;
